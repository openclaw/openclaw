import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import {
  githubJson as json,
  queuedFetch as fetchResponses,
  requestUrl,
} from "./preview.test-support.js";
import type { GitHubTarget } from "./targets.js";
import { parseGitHubTarget } from "./targets.js";

const date = "2026-09-13T12:00:00Z";
const sha = "abcdef0123456789abcdef0123456789abcdef01";
const publicRepo = { id: 123, private: false, visibility: "public" };
let sequence = 0;

function target(kind: "issue" | "pull" | "commit" = "issue", commitSha = sha): GitHubTarget {
  const repo = "detail-" + ++sequence;
  return kind === "commit"
    ? { kind, owner: "octocat", repo, sha: commitSha }
    : { kind, owner: "octocat", repo, number: 1 };
}
function item(overrides: Record<string, unknown> = {}) {
  return {
    title: "Read me",
    body: "# Markdown\n\n  indentation  ",
    user: { login: "octocat" },
    state: "open",
    created_at: date,
    updated_at: date,
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    head: { sha, ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main" },
    ...overrides,
  };
}
function file(overrides: Record<string, unknown> = {}) {
  return {
    filename: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}
function commit(overrides: Record<string, unknown> = {}, commentCount = 0) {
  return {
    sha,
    author: { login: "octocat" },
    commit: {
      message: "Subject\n\nDetails",
      author: { name: "Octocat", date },
      comment_count: commentCount,
    },
    stats: { additions: 1, deletions: 1 },
    files: [file()],
    ...overrides,
  };
}
function commentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    html_url: "https://github.com/octocat/repo/pull/1#issuecomment-1",
    user: { login: "reviewer" },
    created_at: date,
    body: "  Markdown  ",
    ...overrides,
  };
}
function publicFetch(payload: unknown, ...pages: Response[]) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) => {
      const href = requestUrl(url);
      if (href.endsWith("/check-runs?filter=latest&per_page=100")) {
        return json({ total_count: 0, check_runs: [] });
      }
      if (href.endsWith("/status?per_page=100")) {
        return json({ sha, total_count: 0, state: "pending", statuses: [] });
      }
      throw new Error("Unexpected request " + href);
    })
    .mockResolvedValueOnce(json(publicRepo))
    .mockResolvedValueOnce(json(payload));
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce(page);
  }
  return fetchMock;
}

function identity(scope = "selected"): ControlUiGitHubPreviewIdentity {
  return {
    token: "token-" + scope,
    cacheScope: scope,
    revalidate: vi.fn(async () => {}),
    assertSelected: vi.fn(),
  };
}
function revocableIdentity() {
  const selected = identity();
  const revoke = () => {
    selected.assertSelected = () => {
      throw new Error("identity changed");
    };
  };
  return { selected, revoke };
}

function requestPath(input: Parameters<typeof fetch>[0]): string {
  return new URL(requestUrl(input)).pathname;
}
function fullPull() {
  return item({ comments: 1, review_comments: 1, changed_files: 1 });
}
function expectStatus(pending: Promise<unknown>, statusCode: number) {
  return expect(pending).rejects.toMatchObject({ statusCode });
}
function reader(
  input: GitHubTarget,
  selected: ControlUiGitHubPreviewIdentity,
  fetcher: typeof fetch,
) {
  return (
    section?: Parameters<typeof loadGitHubDetail>[4],
    refresh = false,
    caller = selected,
    transport = fetcher,
  ) => loadGitHubDetail(input, caller, transport, refresh, section);
}

function fixture(
  kind: "issue" | "pull" | "commit" = "issue",
  payload: unknown = item(),
  intercept?: Parameters<typeof authenticatedFetch>[1],
) {
  const input = target(kind);
  const selected = identity();
  const fetchMock = authenticatedFetch(payload, intercept);
  return { input, selected, fetchMock, read: reader(input, selected, fetchMock) };
}

function authenticatedFetch(
  payload: unknown = item(),
  intercept?: (
    path: string,
    options?: RequestInit,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  return vi.fn<typeof fetch>(async (url, options) => {
    const path = requestPath(url);
    const response = await intercept?.(path, options);
    if (response) {
      return response;
    }
    if (path.endsWith("/check-runs")) {
      return json({ total_count: 0, check_runs: [] });
    }
    if (path.endsWith("/status")) {
      return json({ sha, total_count: 0, state: "pending", statuses: [] });
    }
    if (/^\/repos\/[^/]+\/[^/]+$/u.test(path)) {
      return json(publicRepo);
    }
    if (path.endsWith("/comments")) {
      return json([commentItem({ diff_hunk: "@@ -1 +1 @@\n-old\n+new" })]);
    }
    if (path.endsWith("/files")) {
      return json([file()]);
    }
    return json(payload);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub detail selected read identity", () => {
  it.each(["pull", "commit"] as const)(
    "uses the prepared credential for the entire %s document and refresh",
    async (kind) => {
      const payload = kind === "commit" ? commit({}, 1) : fullPull();
      const { selected, fetchMock, read } = fixture(kind, payload);
      const first = await read();
      expect(first).toMatchObject({
        partial: false,
        comments: expect.arrayContaining([expect.any(Object)]),
      });
      if (kind === "pull") {
        expect(first.checks).toMatchObject({
          state: "neutral",
          commit: sha,
          summary: "No checks reported",
          total: 0,
          items: [],
          truncated: false,
        });
        expect(first.metadata).toEqual([
          { label: "Files", value: "1" },
          { label: "Comments", value: "1" },
          { label: "Branch", value: "feature → main" },
        ]);
      }
      expect(await read()).toBe(first);
      await read(undefined, true);
      for (const [, options] of fetchMock.mock.calls) {
        expect(options?.headers).toHaveProperty("Authorization", "Bearer " + selected.token);
      }
      const itemPath = kind === "commit" ? "/commits/" + sha : "/pulls/1";
      expect(
        fetchMock.mock.calls.filter(([url]) => requestPath(url).endsWith(itemPath)),
      ).toHaveLength(2);
      expect(selected.revalidate).toHaveBeenCalled();
    },
  );

  it("keeps an exhausted anonymous quota separate from the selected credential", async () => {
    const authorized = vi.fn();
    const { input, fetchMock, read } = fixture("issue", item(), (_, options) => {
      if (new Headers(options?.headers).has("Authorization")) {
        authorized();
        return undefined;
      }
      return json({}, 403, { "x-ratelimit-remaining": "0", "retry-after": "3600" });
    });
    await expectStatus(loadGitHubDetail(input, undefined, fetchMock), 429);
    await expect(read()).resolves.toMatchObject({
      title: "Read me",
    });
    expect(authorized).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 429])(
    "retries optional credentials anonymously after HTTP %s, including cached delivery",
    async (status) => {
      for (const cached of [false, true]) {
        const input = target();
        const selected = { ...identity(), optionalAuth: true as const };
        let unavailable = !cached;
        const fetchMock = authenticatedFetch(item(), (_, options) => {
          const authorized = new Headers(options?.headers).has("Authorization");
          if (unavailable && authorized) {
            return json({}, status);
          }
          return undefined;
        });
        if (cached) {
          await loadGitHubDetail(input, selected, fetchMock);
          unavailable = true;
        }
        await expect(loadGitHubDetail(input, selected, fetchMock)).resolves.toMatchObject({
          title: "Read me",
        });
        const anonymous = fetchMock.mock.calls.filter(
          ([, options]) => !new Headers(options?.headers).has("Authorization"),
        );
        expect(anonymous.map(([url]) => requestPath(url))).toEqual([
          `/repos/${input.owner}/${input.repo}`,
          `/repos/${input.owner}/${input.repo}/issues/1`,
        ]);
        expect(selected.revalidate).toHaveBeenCalled();
        expect(selected.assertSelected).toHaveBeenCalled();
      }
    },
  );

  it("does not bypass a managed identity after an authentication failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));
    await expectStatus(loadGitHubDetail(target(), identity(), fetchMock), 401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty("Authorization");
  });

  it.each([
    { name: "private", repository: { id: 123, private: true, visibility: "private" } },
    { name: "internal", repository: { id: 123, private: false, visibility: "internal" } },
    { name: "missing-visibility", repository: { id: 123, private: false } },
    { name: "replacement", repository: { id: 456, private: false, visibility: "public" } },
  ])(
    "does not deliver freshly read or cached content from a $name repository",
    async ({ repository }) => {
      for (const cached of [false, true]) {
        const input = target();
        const selected = identity();
        const upstream = authenticatedFetch();
        let changed = false;
        const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
          const isRepository = /^\/repos\/[^/]+\/[^/]+$/u.test(requestPath(url));
          if (changed && isRepository) {
            return json(repository);
          }
          const response = await upstream(url, options);
          if (!cached && !isRepository) {
            changed = true;
          }
          return response;
        });
        if (cached) {
          await loadGitHubDetail(input, selected, fetchMock);
          changed = true;
        }
        await expectStatus(loadGitHubDetail(input, selected, fetchMock), 404);
      }
    },
  );

  it.each(["item", "review", "files"] as const)(
    "rejects a redirected %s before sending credentials to a different repository's content",
    async (stage) => {
      const input = target("pull");
      const suffix =
        "/pulls/1" + (stage === "item" ? "" : stage === "review" ? "/comments" : "/files");
      const fetchMock = authenticatedFetch(fullPull(), (pathname) => {
        if (pathname === "/repos/octocat/another") {
          return json({ id: 456, private: false, visibility: "public" });
        }
        if (pathname.endsWith(suffix)) {
          return new Response(null, {
            status: 301,
            headers: { Location: "/repos/octocat/another" + suffix },
          });
        }
        return undefined;
      });
      await expectStatus(loadGitHubDetail(input, identity(), fetchMock), 404);
      expect(fetchMock.mock.calls.some(([url]) => requestUrl(url).includes("/another/"))).toBe(
        false,
      );
    },
  );

  it("allows a public repository rename while retaining its immutable identity", async () => {
    const input = target();
    const selected = identity();
    const fetchMock = authenticatedFetch(item(), (pathname) => {
      if (pathname === "/repos/octocat/" + input.repo + "/issues/1") {
        return new Response(null, {
          status: 301,
          headers: { Location: "/repositories/123/issues/1" },
        });
      }
      return pathname === "/repositories/123" ? json(publicRepo) : undefined;
    });
    await expect(loadGitHubDetail(input, selected, fetchMock)).resolves.toMatchObject({
      title: "Read me",
    });
    expect(
      fetchMock.mock.calls.some(([url]) => requestUrl(url).endsWith("/repositories/123/issues/1")),
    ).toBe(true);
  });

  it("separates selected credential scopes and rotations", async () => {
    const first = identity("first");
    const second = identity("second");
    const rotated = { ...first, token: "rotated-token" };
    const { read } = fixture("issue", item(), (path, options) => {
      if (path.endsWith("/issues/1")) {
        return json(item({ title: new Headers(options?.headers).get("Authorization") }));
      }
      return undefined;
    });
    for (const selected of [first, second, rotated]) {
      await expect(read(undefined, false, selected)).resolves.toMatchObject({
        title: "Bearer " + selected.token,
      });
    }
  });

  it("retains a completed authenticated refresh after an older request finishes first", async () => {
    const responses = [createDeferred<Response>(), createDeferred<Response>()];
    const started = [createDeferred<void>(), createDeferred<void>()];
    let itemRequests = 0;
    const { read } = fixture("issue", item(), (path) => {
      if (path.endsWith("/issues/1")) {
        const index = itemRequests++;
        started[index]?.resolve();
        const response = responses[index];
        if (!response) {
          throw new Error("Unexpected item fetch after completed refresh");
        }
        return response.promise;
      }
      return undefined;
    });
    const first = read();
    await started[0]!.promise;
    const refreshed = read(undefined, true, identity());
    await started[1]!.promise;
    responses[0]!.resolve(json(item({ body: "Old body" })));
    await expect(first).resolves.toMatchObject({ body: "Old body" });
    responses[1]!.resolve(json(item({ body: "Refreshed body" })));
    await expect(refreshed).resolves.toMatchObject({ body: "Refreshed body" });
    await expect(read(undefined, false, identity())).resolves.toMatchObject({
      body: "Refreshed body",
    });
    expect(itemRequests).toBe(2);
  });

  it.each(["optional content", "concurrent repository read"])(
    "rejects a disconnected caller during %s without poisoning another reader",
    async (stage) => {
      const input = target();
      const { selected, revoke } = revocableIdentity();
      const pending = createDeferred<Response>();
      const started = createDeferred<void>();
      let waiting = stage === "concurrent repository read";
      const payload = item({ comments: waiting ? 0 : 1 });
      const fetchMock = authenticatedFetch(payload, (path) => {
        if (waiting) {
          waiting = false;
          started.resolve();
          return pending.promise;
        }
        if (stage === "optional content" && path.endsWith("/comments")) {
          revoke();
          return json({}, 503);
        }
        return undefined;
      });
      const first = loadGitHubDetail(input, selected, fetchMock);
      if (stage === "concurrent repository read") {
        await started.promise;
        await expect(loadGitHubDetail(input, identity(), fetchMock)).resolves.toMatchObject({
          title: "Read me",
        });
        revoke();
        pending.resolve(json(publicRepo));
      }
      await expect(first).rejects.toThrow("identity changed");
      const healthyFetch = stage === "optional content" ? authenticatedFetch(payload) : fetchMock;
      await expect(loadGitHubDetail(input, identity(), healthyFetch)).resolves.toMatchObject({
        title: "Read me",
        partial: false,
      });
    },
  );
});

describe("GitHub detail public read boundary", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-ambient-token");
  });

  it("stops private repositories before fetching the object", async () => {
    for (const selected of [undefined, identity()]) {
      const fetchMock = fetchResponses(
        json({ ...publicRepo, private: true, visibility: "private" }),
      );
      await expectStatus(loadGitHubDetail(target(), selected, fetchMock), 404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    "https://example.com/private",
    "http://api.github.com/repos/octocat/repo",
    "https://user:password@api.github.com/repos/octocat/repo",
  ])("rejects redirect %s without following it", async (location) => {
    const redirect = new Response("discard", { status: 301, headers: { Location: location } });
    const fetchMock = fetchResponses(json(publicRepo), redirect);
    await expectStatus(loadGitHubDetail(target(), undefined, fetchMock), 502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redirect.bodyUsed).toBe(true);
  });

  it("caps redirect chains", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 301, headers: { Location: "/repositories/123" } }),
      );
    await expectStatus(loadGitHubDetail(target(), undefined, fetchMock), 502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("normalizes a retry-after rate limit and caches repeated opens", async () => {
    const input = target();
    const fetchMock = fetchResponses(json({ message: "upstream" }, 403, { "retry-after": "60" }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectStatus(loadGitHubDetail(input, undefined, fetchMock), 429);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expires cached visibility failures rather than making a missing repository permanently unavailable", async () => {
    const input = target();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = fetchResponses(json({}, 404), json(publicRepo), json(item()));
    await expectStatus(loadGitHubDetail(input, undefined, fetchMock), 404);
    now.mockReturnValue(32_000);
    await expect(loadGitHubDetail(input, undefined, fetchMock)).resolves.toMatchObject({
      partial: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds discussion, review context, and file patches with explicit partial flags", async () => {
    const comment = commentItem({ body: "x".repeat(5000) });
    const fetchMock = publicFetch(
      item({ body: "b".repeat(40_000), comments: 25, review_comments: 25, changed_files: 35 }),
      json(
        Array.from({ length: 25 }, () => comment),
        200,
        { Link: '<https://api.github.com/ignored>; rel="next"' },
      ),
      json(
        Array.from({ length: 25 }, () =>
          commentItem({ body: comment.body, path: "src/file.ts", diff_hunk: "h".repeat(5000) }),
        ),
      ),
      json(Array.from({ length: 35 }, () => file({ patch: "p".repeat(20_000) }))),
    );
    const detail = await loadGitHubDetail(target("pull"), undefined, fetchMock);
    expect(detail).toMatchObject({
      bodyTruncated: true,
      commentsTruncated: true,
      filesTruncated: true,
      partial: true,
      commentsTotal: 50,
      filesTotal: 35,
    });
    expect(detail.body).toHaveLength(32 * 1024);
    const reviews = detail.comments.filter((entry) => entry.label === "Review comment");
    expect(reviews).toMatchObject(
      Array.from({ length: 20 }, () => ({
        context: { diff: "h".repeat(4096), diffTruncated: true },
      })),
    );
    expect(detail.comments).toMatchObject(
      Array.from({ length: 40 }, () => ({
        body: "x".repeat(4096),
        bodyTruncated: true,
      })),
    );
    expect(detail.files).toHaveLength(30);
    expect(detail.files.reduce((sum, entry) => sum + (entry.patch?.length ?? 0), 0)).toBe(
      96 * 1024,
    );
    expect(
      detail.files.every(
        (entry) => entry.patchTruncated && (entry.patch?.length ?? 0) <= 16 * 1024,
      ),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/issues/1/comments?per_page=20");
    expect(fetchMock.mock.calls[3]?.[0]).toContain(
      "/pulls/1/comments?per_page=20&sort=created&direction=asc",
    );
    expect(fetchMock.mock.calls[4]?.[0]).toContain("/pulls/1/files?per_page=30");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("keeps truncated GitHub bodies and patches UTF-16 safe at the cut boundary", async () => {
    const bodyPrefix = "a".repeat(32 * 1024 - 1);
    const patchPrefix = "p".repeat(16 * 1024 - 1);
    const fetchMock = publicFetch(
      item({ body: bodyPrefix + "\u{1F600}tail", changed_files: 1 }),
      json([file({ patch: patchPrefix + "\u{1F600}tail" })]),
    );
    const detail = await loadGitHubDetail(target("pull"), undefined, fetchMock);
    expect(detail).toMatchObject({
      body: bodyPrefix,
      bodyTruncated: true,
      partial: true,
      files: [{ patch: patchPrefix, patchTruncated: true }],
    });
  });

  it("renders complete discussion, review context and renamed files", async () => {
    const discussion = commentItem({ id: 3, created_at: "2026-09-13T12:01:00Z", user: null });
    const diffHunk = "@@ -12,3 +12,3 @@\n-old\n+new";
    const review = commentItem({
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r1",
      path: "src/file.ts",
      line: null,
      original_line: 14,
      start_line: null,
      original_start_line: 12,
      side: "RIGHT",
      diff_hunk: diffHunk,
    });
    const reply = commentItem({
      id: 2,
      created_at: "2026-09-13T12:02:00Z",
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r2",
      in_reply_to_id: 1,
      path: "src/file.ts",
      line: 15,
      start_line: 13,
      diff_hunk: diffHunk,
    });
    const fetchMock = publicFetch(
      item({ comments: 1, review_comments: 2, changed_files: 1 }),
      json([discussion]),
      json([review, reply]),
      json([file({ status: "renamed", previous_filename: "old.ts" })]),
    );
    const detail = await loadGitHubDetail(target("pull"), undefined, fetchMock);
    expect(detail).toMatchObject({
      partial: false,
      commentsTotal: 3,
      commentsTruncated: false,
      files: [{ previousPath: "old.ts", patch: file().patch, patchTruncated: false }],
      comments: [
        {
          id: "discussion_r1",
          label: "Review comment",
          url: review.html_url,
          context: {
            path: "src/file.ts",
            lineLabel: "12–14",
            label: "After change · Outdated",
            diff: diffHunk,
            diffTruncated: false,
          },
        },
        {
          id: "issuecomment-1",
          url: discussion.html_url,
          body: discussion.body,
          author: "ghost",
          bodyTruncated: false,
        },
        {
          id: "discussion_r2",
          label: "Review comment",
          context: { lineLabel: "13–15", replyLabel: "In reply to #1", replyUrl: review.html_url },
        },
      ],
    });
    expect(detail.comments[1]?.context).toBeUndefined();
  });

  it("loads commit comments with source permalinks and optional file locations anonymously", async () => {
    const first = commentItem({
      html_url: "https://github.com/octocat/repo/commit/" + sha + "#commitcomment-1",
      path: "src/file.ts",
      line: 14,
    });
    const second = commentItem({
      id: 2,
      html_url: "https://github.com/octocat/repo/commit/" + sha + "#commitcomment-2",
      path: null,
      line: null,
    });
    const fetchMock = publicFetch(commit({}, 2), json([first, second]));
    const detail = await loadGitHubDetail(
      target("commit", sha.slice(0, 7).toUpperCase()),
      undefined,
      fetchMock,
    );
    expect(detail).toMatchObject({
      partial: false,
      commentsTotal: 2,
      commentsTruncated: false,
      comments: [
        {
          url: first.html_url,
          context: { path: "src/file.ts", lineLabel: "14" },
          body: first.body,
        },
        { url: second.html_url },
      ],
    });
    expect(detail.metadata).toEqual([
      { label: "Additions", value: "+1", tone: "positive" },
      { label: "Deletions", value: "−1", tone: "negative" },
    ]);
    expect(detail.comments[1]?.context?.lineLabel).toBeUndefined();
    expect(detail.comments[1]?.context?.path).toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0]).toContain(
      "/commits/" + sha.slice(0, 7) + "/comments?per_page=20",
    );
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it.each(["comments", "files"] as const)(
    "keeps the item visible when %s cannot load",
    async (section) => {
      const fetchMock = publicFetch(
        item({
          comments: section === "comments" ? 1 : 0,
          changed_files: section === "files" ? 1 : 0,
        }),
        json({}, 429),
      );
      const detail = await loadGitHubDetail(target("pull"), undefined, fetchMock);
      expect(detail).toMatchObject({
        title: "Read me",
        partial: true,
        [section + "Truncated"]: true,
        [section]: [],
      });
    },
  );

  it.each(["https://example.com/steal", "https://user:secret@github.com/owner/repo"])(
    "marks incomplete commit comments for unsafe permalink %s without losing the commit",
    async (html_url) => {
      const fetchMock = publicFetch(commit({}, 1), json([commentItem({ html_url })]));
      const detail = await loadGitHubDetail(target("commit"), undefined, fetchMock);
      expect(detail).toMatchObject({
        title: "Subject",
        partial: true,
        commentsTruncated: true,
        commentsTotal: 1,
      });
      expect(detail.comments).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("marks omitted binary patches and commit file pagination rather than claiming complete content", async () => {
    const fetchMock = fetchResponses(
      json(publicRepo),
      json(
        commit({
          author: null,
          commit: { author: null, message: "", comment_count: 0 },
          files: [file({ patch: undefined })],
        }),
        200,
        { Link: '<https://api.github.com/ignored>; rel="next"' },
      ),
    );
    const detail = await loadGitHubDetail(target("commit"), undefined, fetchMock);
    expect(detail).toMatchObject({
      badge: { label: "Commit", tone: "neutral" },
      author: "ghost",
      body: "",
      filesTruncated: true,
      partial: true,
      files: [{ patchTruncated: true }],
    });
    expect(detail.createdAt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "rejects oversized main responses (declared length: %s)",
    async (declaredLength) => {
      const response = new Response("x".repeat(1024 * 1024 + 1), {
        headers: declaredLength ? { "Content-Length": String(1024 * 1024 + 1) } : {},
      });
      const fetchMock = fetchResponses(json(publicRepo), response);
      await expect(loadGitHubDetail(target(), undefined, fetchMock)).rejects.toThrow();
      expect(response.bodyUsed).toBe(true);
    },
  );
});

describe("progressive GitHub documents", () => {
  it.each([200, 503])(
    "overlaps discussion and review reads when discussion returns %s",
    async (status) => {
      vi.useFakeTimers();
      try {
        const { read } = fixture("pull", fullPull(), async (path) => {
          if (!path.endsWith("/comments")) {
            return undefined;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return path.includes("/issues/")
            ? json([commentItem()], status)
            : json([
                commentItem({
                  id: 2,
                  html_url: "https://github.com/octocat/repo/pull/1#discussion_r2",
                }),
              ]);
        });
        const started = Date.now();
        const pending = read("discussion");
        await vi.runAllTimersAsync();
        const document = await pending;
        expect(Date.now() - started).toBe(100);
        expect(document.comments?.map((comment) => comment.id)).toEqual(
          status === 200 ? ["discussion_r2", "issuecomment-1"] : ["discussion_r2"],
        );
        expect(document.commentsTotal).toBe(2);
        expect(document.commentsTruncated).toBe(status !== 200);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("delivers the overview before slow checks, loads discussion independently, and reads files only on demand", async () => {
    const input = target("pull");
    const checks = createDeferred<Response>();
    const checksStarted = createDeferred<void>();
    let delayChecks = true;
    const fetchMock = authenticatedFetch(fullPull(), (path) => {
      if (delayChecks && path.endsWith("/check-runs")) {
        delayChecks = false;
        checksStarted.resolve();
        return checks.promise;
      }
      return undefined;
    });
    const selected = identity("progressive");
    const read = reader(input, selected, fetchMock);
    const overview = await read("overview");
    expect(overview).toMatchObject({
      title: "Read me",
      body: "# Markdown\n\n  indentation  ",
      revision: sha,
      deferredSections: ["checks", "files", "discussion"],
      partial: false,
    });
    expect(overview.checks).toBeUndefined();
    expect(overview.comments).toBeUndefined();
    expect(overview.files).toBeUndefined();
    expect(
      fetchMock.mock.calls.every(
        ([url]) => !/\/(?:comments|files|check-runs|status)(?:\?|$)/u.test(requestUrl(url)),
      ),
    ).toBe(true);

    const pendingChecks = read("checks");
    await checksStarted.promise;
    try {
      const discussion = await read("discussion", false, identity("progressive"));
      expect(discussion).toMatchObject({
        revision: sha,
        commentsTotal: 2,
        commentsTruncated: false,
      });
      expect(discussion.comments).toHaveLength(2);
      expect(discussion.checks).toBeUndefined();
      expect(discussion.files).toBeUndefined();
      const paths = fetchMock.mock.calls.map(([url]) => requestPath(url));
      expect(paths.filter((path) => path.endsWith("/pulls/1"))).toHaveLength(1);
      expect(paths.some((path) => path.endsWith("/files"))).toBe(false);
      const files = await read("files");
      expect(files).toMatchObject({
        revision: sha,
        filesTotal: 1,
        filesTruncated: false,
        files: [{ path: "src/file.ts", patch: file().patch }],
      });
      expect(files.comments).toBeUndefined();
      expect(files.checks).toBeUndefined();
    } finally {
      checks.resolve(json({ total_count: 0, check_runs: [] }));
    }
    expect(await pendingChecks).toMatchObject({
      revision: sha,
      checks: { commit: sha, state: "neutral" },
    });
    // Omitting section still returns the shipped full document, not the overview cache.
    const complete = await read();
    expect(complete).toMatchObject({
      partial: false,
      commentsTotal: 2,
      filesTotal: 1,
      checks: { commit: sha, state: "neutral" },
    });
    expect(complete.comments).toHaveLength(2);
    expect(complete.files).toHaveLength(1);
    expect(complete.deferredSections).toBeUndefined();
  });

  it("retires cached sections when a refreshed overview selects another head", async () => {
    const input = target("pull");
    let currentSha = sha;
    const fetchMock = authenticatedFetch(item(), (path) => {
      if (path.endsWith("/pulls/1")) {
        return json(item({ head: { sha: currentSha } }));
      }
      if (path.endsWith("/status")) {
        return json({ sha: currentSha, total_count: 0, statuses: [] });
      }
      return undefined;
    });
    const selected = identity("progressive-refresh");
    const read = reader(input, selected, fetchMock);
    await read("overview");
    expect((await read("checks")).checks?.commit).toBe(sha);
    currentSha = "d".repeat(40);
    const overview = await read("overview", true);
    const checks = await read("checks");
    expect(overview.revision).toBe(currentSha);
    expect(checks).toMatchObject({
      revision: currentSha,
      checks: { commit: currentSha, state: "neutral" },
    });
  });

  it("rejects an on-demand PR diff if its head moves during the files read", async () => {
    const input = target("pull");
    const upstream = authenticatedFetch(item({ changed_files: 1 }));
    let filesRead = false;
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      const path = requestPath(url);
      if (filesRead && path.endsWith("/pulls/1")) {
        return json(item({ changed_files: 1, head: { sha: "d".repeat(40) } }));
      }
      const result = await upstream(url, options);
      filesRead ||= path.endsWith("/files");
      return result;
    });
    await expect(
      loadGitHubDetail(input, identity(), fetchMock, false, "files"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rechecks current visibility and caller authority when sections reuse a settled overview", async () => {
    const { selected, read } = fixture("pull");
    await read("overview");
    selected.assertSelected = () => {
      throw new Error("Reader retired");
    };
    const blocked = vi.fn<typeof fetch>();
    await expect(read("checks", false, selected, blocked)).rejects.toThrow("Reader retired");
    expect(blocked).not.toHaveBeenCalled();
    const privateRepo = vi.fn<typeof fetch>(async () =>
      json({ id: 123, private: true, visibility: "private" }),
    );
    await expect(read("discussion", false, identity(), privateRepo)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(privateRepo).toHaveBeenCalledTimes(1);
    // A completed source never retains the first caller's assertions.
    await expect(read("checks", false, identity())).resolves.toMatchObject({
      revision: sha,
      checks: { state: "neutral" },
    });
  });

  it("does not label updated issue discussion with a cached overview revision", async () => {
    const { selected, read } = fixture();
    const overview = await read("overview");
    const updatedAt = "2026-10-17T00:00:00Z";
    const discussion = await read(
      "discussion",
      false,
      selected,
      authenticatedFetch(item({ updated_at: updatedAt })),
    );
    expect(overview.revision).toBe(date);
    expect(discussion.revision).toBe(updatedAt);
  });

  it.each(["issue", "commit"] as const)(
    "defers only supported %s sections and binds them to the source revision",
    async (kind) => {
      const { read } = fixture(kind, kind === "commit" ? commit() : item());
      const overview = await read("overview");
      expect(overview.revision).toBe(kind === "commit" ? sha : date);
      expect(overview.deferredSections).toEqual(
        kind === "commit" ? ["files", "discussion"] : ["discussion"],
      );
      expect(overview.files).toBeUndefined();
      expect(overview.comments).toBeUndefined();
      const discussion = await read("discussion");
      expect(discussion).toMatchObject({
        revision: overview.revision,
        comments: [],
        commentsTotal: 0,
      });
    },
  );
});

describe("GitHub detail target validation", () => {
  it.each([
    null,
    { kind: "commit", owner: "octocat", repo: "repo", sha: "abcdef0/../../secrets" },
    { kind: "commit", owner: "octocat", repo: "repo", sha, number: 1 },
    { kind: "issue", owner: "octocat", repo: "repo", sha, number: 1 },
  ])("rejects malformed target %#", (value) => {
    expect(parseGitHubTarget(value)).toBeNull();
  });
});
