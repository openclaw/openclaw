import { describe, expect, it } from "vitest";
import type { XPost } from "./api.js";
import { resolveXRecipient } from "./recipient.js";
import { createContextApi } from "./test-support/context-api.js";

describe("X reply recipients", () => {
  it.each([
    ["reassigned configured handle", { username: "oldbot" }, "99", undefined, 1],
    ["current bot handle", { username: "currentbot" }, "9", "20", 1],
    ["stable bot id", { id: "9", username: "oldbot" }, "99", "20", 0],
  ] as const)(
    "verifies the numeric recipient for %s",
    async (_label, mention, resolvedId, expected, lookups) => {
      let userLookups = 0;
      const api = createContextApi(async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith("/2/users/by/username/")) {
          userLookups++;
          return Response.json({ data: { id: resolvedId, username: mention.username } });
        }
        throw new Error("Unexpected X lookup");
      });
      const result = await resolveXRecipient({
        api,
        post: {
          id: "20",
          author_id: "7",
          conversation_id: "20",
          text: "Please help",
          entities: { mentions: [mention] },
        },
        userId: "9",
      });
      expect([result?.post.id, userLookups]).toEqual([expected, lookups]);
    },
  );

  it.each([
    { quotedAuthor: "9", eligible: true },
    { quotedAuthor: "99", eligible: false },
  ])(
    "admits a quote of author $quotedAuthor only when it belongs to this bot",
    async ({ quotedAuthor, eligible }) => {
      const target: XPost = {
        id: "20",
        author_id: "7",
        conversation_id: "20",
        text: "Please investigate this",
        referenced_tweets: [{ type: "quoted", id: "10" }],
        entities: {},
      };
      const requested: string[] = [];
      const api = createContextApi(async (input) => {
        const url = new URL(input);
        const id = url.searchParams.get("ids")!;
        requested.push(id);
        return Response.json({
          data:
            id === "20"
              ? [target]
              : [{ id: "10", author_id: quotedAuthor, conversation_id: "10", text: "Original" }],
        });
      });
      const result = await resolveXRecipient({ api, post: "20", userId: "9" });
      expect([result?.post.id, requested]).toEqual([eligible ? "20" : undefined, ["20", "10"]]);
    },
  );
});
