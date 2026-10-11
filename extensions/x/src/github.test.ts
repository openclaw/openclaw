import { afterEach, describe, expect, it, vi } from "vitest";
import { createXGitHubReader, type XGitHubPermission } from "./github.js";

type GitHubFetch = NonNullable<Parameters<typeof createXGitHubReader>[0]["fetch"]>;

function collaborator(login: string, permission?: XGitHubPermission) {
  return {
    id: 1,
    login,
    permissions: {
      push: Boolean(permission),
      maintain: permission === "maintain",
      admin: permission === "admin",
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("GitHub-derived X verification reader", () => {
  it.each([
    { minimum: "push", expected: ["writer_acme", "maintainer", "admin"] },
    { minimum: "maintain", expected: ["maintainer", "admin"] },
    { minimum: "admin", expected: ["admin"] },
  ] as const)(
    "paginates regular and managed collaborators and filters at $minimum permission",
    async ({ minimum, expected }) => {
      const pages: string[] = [];
      const profiles: string[] = [];
      const reader = createXGitHubReader({
        token: "test-token",
        fetch: async (input, init) => {
          const url = new URL(input);
          expect(url.origin).toBe("https://api.github.com");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
          if (url.pathname.endsWith("/collaborators")) {
            expect(url.searchParams.get("affiliation")).toBe("all");
            expect(url.searchParams.get("per_page")).toBe("100");
            const page = url.searchParams.get("page")!;
            pages.push(page);
            return Response.json(
              page === "1"
                ? Array.from({ length: 100 }, (_, index) => collaborator(`reader_${index}`))
                : [
                    collaborator("writer_acme", "push"),
                    collaborator("maintainer", "maintain"),
                    collaborator("admin", "admin"),
                  ],
            );
          }
          if (url.pathname.endsWith("/social_accounts")) {
            return Response.json([]);
          }
          const login = url.pathname.slice("/users/".length);
          profiles.push(login);
          return Response.json({ id: 1, login, twitter_username: login });
        },
      });
      expect(
        (await reader.readCollaborators("test/repo", minimum)).map((row) => row.githubLogin),
      ).toEqual(expected);
      expect(profiles).toEqual(expected);
      expect(pages).toEqual(["1", "2"]);
    },
  );

  it("combines profile and social declarations, normalizes handles, and ignores invalid declarations", async () => {
    const reader = createXGitHubReader({
      token: "test-token",
      fetch: async (input) => {
        const path = new URL(input).pathname;
        if (path.endsWith("/collaborators")) {
          return Response.json([collaborator("writer", "push"), collaborator("empty", "push")]);
        }
        if (path === "/users/writer") {
          return Response.json({ id: 1, login: "writer", twitter_username: "@Alice" });
        }
        if (path === "/users/empty") {
          return Response.json({
            id: 1,
            login: "empty",
            twitter_username: "too_long_to_be_a_handle",
          });
        }
        return Response.json(
          path.includes("/writer/")
            ? [
                { provider: "twitter", url: "https://twitter.com/ALICE" },
                { provider: "generic", url: "https://x.com/Bob" },
                { provider: "twitter", url: "@Carol" },
                { provider: "generic", url: "https://www.twitter.com/Dave/" },
                { provider: "generic", url: "https://github.com/unrelated" },
                { provider: "twitter", url: "https://x.com/alice/status/123" },
                { provider: "twitter", url: "https://x.com.evil.example/alice" },
                { provider: "twitter", url: "https://x.com@evil.example/alice" },
              ]
            : [],
        );
      },
    });
    expect(await reader.readCollaborators("test/repo", "push")).toEqual([
      { githubLogin: "writer", permission: "push", xHandles: ["alice", "bob", "carol", "dave"] },
      { githubLogin: "empty", permission: "push", xHandles: [] },
    ]);
  });

  it("revalidates cached profiles and social accounts, observes removed handles, and prunes departed collaborators", async () => {
    let sync = 1;
    const conditionals: [number, string, string | null][] = [];
    const reader = createXGitHubReader({
      token: "test-token",
      fetch: async (input, init) => {
        const path = new URL(input).pathname;
        if (path.endsWith("/collaborators")) {
          return Response.json(sync === 4 ? [] : [collaborator("writer", "push")]);
        }
        const etag = new Headers(init?.headers).get("if-none-match");
        conditionals.push([sync, path, etag]);
        if (sync === 2) {
          return new Response(null, { status: 304 });
        }
        const social = path.endsWith("/social_accounts");
        return Response.json(
          social
            ? sync === 3
              ? []
              : [{ provider: "twitter", url: "https://x.com/second" }]
            : { id: 1, login: "writer", twitter_username: sync === 3 ? null : "first" },
          { headers: { etag: `"${social ? "social" : "profile"}-${sync}"` } },
        );
      },
    });
    expect((await reader.readCollaborators("test/repo", "push"))[0]?.xHandles).toEqual([
      "first",
      "second",
    ]);
    sync = 2;
    expect((await reader.readCollaborators("test/repo", "push"))[0]?.xHandles).toEqual([
      "first",
      "second",
    ]);
    sync = 3;
    expect((await reader.readCollaborators("test/repo", "push"))[0]?.xHandles).toEqual([]);
    sync = 4;
    expect(await reader.readCollaborators("test/repo", "push")).toEqual([]);
    sync = 5;
    await reader.readCollaborators("test/repo", "push");
    expect(conditionals.filter(([round]) => round === 2)).toEqual([
      [2, "/users/writer", '"profile-1"'],
      [2, "/users/writer/social_accounts", '"social-1"'],
    ]);
    expect(conditionals.filter(([round]) => round === 5).map((entry) => entry[2])).toEqual([
      null,
      null,
    ]);
  });

  it.each<{ code: number; headers: Record<string, string>; advance: number }>([
    { code: 429, headers: { "retry-after": "120" }, advance: 120_000 },
    {
      code: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000180" },
      advance: 180_000,
    },
    { code: 403, headers: {}, advance: 60_000 },
  ])(
    "honors rate-limit cooldown for HTTP $code without dispatching early retries",
    async ({ code, headers, advance }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);
      const fetch = vi
        .fn<GitHubFetch>()
        .mockResolvedValueOnce(
          Response.json(
            { message: "You have exceeded a secondary rate limit. test-token" },
            { status: code, headers },
          ),
        )
        .mockImplementation(async () => Response.json([]));
      const reader = createXGitHubReader({ token: "test-token", fetch });
      await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow(
        /^GitHub rate limit reached; retry after /,
      );
      await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow("rate limit");
      expect(fetch).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(advance);
      expect(await reader.readCollaborators("test/repo", "push")).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("stops at exhausted quota after a successful page instead of starting more requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<GitHubFetch>(async () =>
      Response.json([collaborator("writer", "push")], {
        headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
      }),
    );
    const reader = createXGitHubReader({ token: "test-token", fetch });
    await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow("rate limit");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])(
    "explains collaborator credential failures for HTTP %s without reflecting GitHub bodies",
    async (code) => {
      const reader = createXGitHubReader({
        token: "test-token",
        fetch: async () => Response.json({ message: "private test-token" }, { status: code }),
      });
      await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow(
        `GitHub cannot list repository collaborators (HTTP ${code}); check the repository and verifiedFromGitHub.token access and permissions.`,
      );
    },
  );

  it.each([
    { label: "invalid listing", path: "collaborators", body: {} },
    { label: "missing permission", path: "collaborators", body: [{ id: 1, login: "writer" }] },
    {
      label: "invalid permission",
      path: "collaborators",
      body: [{ id: 1, login: "writer", permissions: { push: "true" } }],
    },
    { label: "missing profile identity", path: "writer", body: {} },
    {
      label: "changed profile identity",
      path: "writer",
      body: { id: 2, login: "writer", twitter_username: "imposter" },
    },
    { label: "invalid social accounts", path: "social_accounts", body: {} },
  ])("rejects $label rather than returning a partial verified set", async ({ path, body }) => {
    const reader = createXGitHubReader({
      token: "test-token",
      fetch: async (input) => {
        const pathname = new URL(input).pathname;
        return Response.json(
          pathname.endsWith(path)
            ? body
            : pathname.endsWith("collaborators")
              ? [collaborator("writer", "push")]
              : { id: 1, login: "writer", twitter_username: "alice" },
        );
      },
    });
    await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow("invalid response");
  });

  it("fails a profile network error with a safe message and rejects path traversal before fetching", async () => {
    const fetch = vi.fn<GitHubFetch>(async (input) => {
      if (new URL(input).pathname.endsWith("collaborators")) {
        return Response.json([collaborator("writer", "push")]);
      }
      throw new Error("private token and transport details");
    });
    const reader = createXGitHubReader({ token: "test-token", fetch });
    await expect(reader.readCollaborators("test/repo", "push")).rejects.toThrow(
      /^GitHub request failed or was cancelled; the last verified set is unchanged.$/,
    );
    fetch.mockClear();
    await expect(reader.readCollaborators("test/..", "push")).rejects.toThrow("owner/name");
    expect(fetch).not.toHaveBeenCalled();
  });
});
