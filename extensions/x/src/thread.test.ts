import { describe, expect, it, vi } from "vitest";
import type { XPost } from "./api.js";
import { createContextApi } from "./test-support/context-api.js";
import { assembleXThread } from "./thread.js";

const trigger: XPost = { id: "11", author_id: "7", conversation_id: "1", text: "Please help" };

describe("X thread context", () => {
  it("preserves the triggering mention when its thread cannot be afforded", async () => {
    const fetch = vi.fn();
    const context = await assembleXThread({ api: createContextApi(fetch, 0), mention: trigger });
    expect(context.posts).toEqual([trigger]);
    expect(context.bodyForAgent).toContain("[triggering mention]: Please help");
    expect(context.bodyForAgent).toContain("thread context truncated by budget");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops searching once the configured number of posts is held", async () => {
    let searches = 0;
    const api = createContextApi(async () => {
      searches++;
      return Response.json({
        data: [trigger, { ...trigger, id: "1", text: "Root" }],
        includes: { users: [{ id: "7", username: "author" }] },
        meta: { next_token: "more" },
      });
    });
    const context = await assembleXThread({ api, mention: trigger, maxPosts: 2 });
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
    const api = createContextApi(async (input) => {
      const url = new URL(input);
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
    });
    const mentionBefore = structuredClone(mention);
    const sortedCopies = vi.spyOn(Array.prototype, "toSorted");
    const reversedCopies = vi.spyOn(Array.prototype, "toReversed");
    let copies = 0;
    const context = await assembleXThread({ api, mention, maxPosts: 5 }).finally(() => {
      copies = sortedCopies.mock.calls.length + reversedCopies.mock.calls.length;
      sortedCopies.mockRestore();
      reversedCopies.mockRestore();
    });
    const { posts, label, bodyForAgent: body } = context;
    expect(fetched).toEqual(["1", "2", "3"]);
    expect(posts.map((value) => value.id)).toEqual(["1", "3", "5", "6", "7"]);
    expect(label).toBe("@maintainer: root");
    expect(body).toBe(
      [
        "X thread context (oldest to newest):",
        "> @maintainer (2026-10-01T00:00:01Z): root",
        "> @maintainer (2026-10-01T00:00:03Z) [quoted post]: quoted context",
        "> @maintainer (2026-10-01T00:00:05Z) [triggering mention]: @bot investigate",
        "> @maintainer (2026-10-01T00:00:06Z): recent",
        "> @maintainer (2026-10-01T00:00:07Z): latest",
        "",
        "Reply to the triggering mention.",
      ].join("\n"),
    );
    expect(mention).toEqual(mentionBefore);
    expect(copies).toBe(0);
  });
});
