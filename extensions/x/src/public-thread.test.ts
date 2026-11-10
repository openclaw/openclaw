import { describe, expect, it, vi } from "vitest";
import type { XPage, XPost } from "./api.js";
import { verifyPublicXThread } from "./public-thread.js";
import { createXTestApi as createXApiClient } from "./test-support/api-client.js";
import { createXTestSpend } from "./test-support/spend.js";

const post: XPost = { id: "1", author_id: "2", conversation_id: "1", text: "Public request" };
const page: XPage = {
  data: [post],
  includes: { tweets: [], users: [{ id: "2", username: "author", protected: false }] },
  meta: {},
};
const verify = (api: Parameters<typeof verifyPublicXThread>[0], posts = [post]) =>
  verifyPublicXThread(api, posts, new AbortController().signal, "1");

describe("public X context", () => {
  it("denies an unavailable conversation root even when its reply is public", async () => {
    const api = { getPublicPosts: vi.fn(async () => page) };
    expect(await verify(api, [{ ...post, id: "3" }])).toBe(false);
    expect(api.getPublicPosts).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "protected", protected: true },
    { kind: "unknown", protected: undefined },
    { kind: "missing", posts: [] },
    { kind: "changed", posts: [{ ...post, text: "Edited" }] },
    { kind: "withheld", posts: [{ ...post, withheld: true }] },
    { kind: "error" },
  ])("fails closed for $kind context", async (scenario) => {
    const { kind } = scenario;
    const data = structuredClone(page);
    Object.assign(
      data.includes.users[0]!,
      "protected" in scenario ? { protected: scenario.protected } : {},
    );
    data.data = scenario.posts ?? data.data;
    const api = {
      getPublicPosts: vi.fn(async () => {
        if (kind === "error") {
          throw new Error("unavailable");
        }
        return data;
      }),
    };
    expect(await verify(api)).toBe(false);
  });

  it("uses only application authority and explicitly requests protected metadata", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/2/tweets");
      expect(url.searchParams.get("user.fields")).toContain("protected");
      expect(url.searchParams.get("tweet.fields")).toContain("withheld");
      expect(url.searchParams.get("expansions")).toBe("author_id");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer app-only-fixture");
      return Response.json(page);
    });
    const api = createXApiClient({
      spend: createXTestSpend(),
      clientId: "fixture",
      clientSecret: "fixture",
      refreshToken: "fixture",
      saveRefreshToken: async () => {},
      bearerToken: "app-only-fixture",
      fetch: fetcher,
    });
    expect(await verify(api)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await api.spend.status()).toMatchObject({ dayUsd: 0.02, cycleUsd: 0.02 });
  });

  it.each([
    { reason: "no app-only token", bearerToken: undefined, dailyUsd: 100, calls: 0 },
    { reason: "exhausted read budget", bearerToken: "app-only-fixture", dailyUsd: 0.01, calls: 0 },
    { reason: "rejected app-only token", bearerToken: "app-only-fixture", dailyUsd: 100, calls: 1 },
  ])(
    "denies publication without user-authority fallback: $reason",
    async ({ bearerToken, dailyUsd, calls }) => {
      const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
        expect(new URL(input).pathname).toBe("/2/tweets");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer app-only-fixture");
        return new Response(null, { status: 401 });
      });
      const api = createXApiClient({
        spend: createXTestSpend({ dailyUsd }),
        clientId: "fixture",
        clientSecret: "fixture",
        refreshToken: "fixture",
        saveRefreshToken: async () => {},
        bearerToken,
        fetch: fetcher,
      });
      expect(await verify(api)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(calls);
      expect(await api.spend.status()).toMatchObject({ dayUsd: 0, cycleUsd: 0 });
    },
  );
});
