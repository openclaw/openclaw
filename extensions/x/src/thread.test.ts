import { describe, expect, it, vi } from "vitest";
import { createXApiClient, type XPost } from "./api.js";
import { createXTestSpend } from "./test-support/spend.js";
import { assembleXThread } from "./thread.js";

describe("X thread context", () => {
  it("preserves the triggering mention when its thread cannot be afforded", async () => {
    const fetch = vi.fn();
    const api = createXApiClient({
      spend: createXTestSpend({ dailyUsd: 0 }),
      clientId: "synthetic",
      clientSecret: "synthetic",
      refreshToken: "synthetic",
      saveRefreshToken: async () => {},
      fetch,
    });
    const mention: XPost = { id: "11", author_id: "7", conversation_id: "1", text: "Please help" };
    const context = await assembleXThread({ api, mention });
    expect(context.posts).toEqual([mention]);
    expect(context.bodyForAgent).toContain("[triggering mention]: Please help");
    expect(context.bodyForAgent).toContain("thread context truncated by budget");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops searching once the configured number of posts is held", async () => {
    const mention: XPost = { id: "11", author_id: "7", conversation_id: "1", text: "Please help" };
    let searches = 0;
    const api = createXApiClient({
      spend: createXTestSpend(),
      clientId: "synthetic",
      clientSecret: "synthetic",
      refreshToken: "synthetic",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        if (input.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "synthetic" });
        }
        searches++;
        return Response.json({
          data: [mention, { ...mention, id: "1", text: "Root" }],
          includes: { users: [{ id: "7", username: "author" }] },
          meta: { next_token: "more" },
        });
      },
    });
    const context = await assembleXThread({ api, mention, maxPosts: 2 });
    expect(searches).toBe(1);
    expect(context.posts.map(({ id }) => id)).toEqual(["1", "11"]);
  });

  it("loads ancestors and quotes, retains the root and trigger, and orders the bounded context", async () => {
    const post = (id: string, text: string, references?: XPost["referenced_tweets"]): XPost => ({
      id,
      text,
      author_id: "4",
      conversation_id: "1",
      created_at: `2026-10-01T00:00:0${id}Z`,
      referenced_tweets: references,
    });
    const root = post("1", "root");
    const parent = post("2", "ancestor", [{ type: "replied_to", id: "1" }]);
    const quote = { ...post("3", "quoted context"), conversation_id: "3" };
    const mention = post("5", "@bot investigate", [
      { type: "replied_to", id: "2" },
      { type: "quoted", id: "3" },
    ]);
    const fetched: string[] = [];
    const api = createXApiClient({
      spend: createXTestSpend(),
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "access" });
        }
        if (url.pathname.endsWith("/search/recent")) {
          expect(url.searchParams.get("query")).toBe("conversation_id:1");
          return Response.json({
            data: [post("7", "latest"), post("6", "recent"), mention],
            includes: { users: [{ id: "4", username: "maintainer" }] },
          });
        }
        const ids = url.searchParams.get("ids")!.split(",");
        fetched.push(...ids);
        return Response.json({
          data: [root, parent, quote].filter((value) => ids.includes(value.id)),
        });
      },
    });
    const context = await assembleXThread({ api, mention, maxPosts: 5 });
    expect(fetched).toEqual(["1", "2", "3"]);
    expect(context.posts.map((value) => value.id)).toEqual(["1", "3", "5", "6", "7"]);
    expect(context.label).toBe("@maintainer: root");
    expect(context.bodyForAgent).toContain(
      "@maintainer (2026-10-01T00:00:03Z) [quoted post]: quoted context",
    );
    expect(context.bodyForAgent).toContain(
      "@maintainer (2026-10-01T00:00:05Z) [triggering mention]: @bot investigate",
    );
    expect(context.bodyForAgent.indexOf("root")).toBeLessThan(
      context.bodyForAgent.indexOf("latest"),
    );
    expect(mention.text).toBe("@bot investigate");
  });
});
