import { describe, expect, it } from "vitest";
import { createXApiClient, type XPost } from "./api.js";
import { resolveXRecipient } from "./recipient.js";
import { createXTestSpend } from "./test-support/spend.js";

describe("X reply recipients", () => {
  it.each([
    {
      label: "reassigned configured handle",
      mention: { username: "oldbot" },
      resolvedId: "99",
      expected: undefined,
      lookups: 1,
    },
    {
      label: "current bot handle",
      mention: { username: "currentbot" },
      resolvedId: "9",
      expected: "20",
      lookups: 1,
    },
    {
      label: "stable bot id",
      mention: { id: "9", username: "oldbot" },
      resolvedId: "99",
      expected: "20",
      lookups: 0,
    },
  ])(
    "verifies the numeric recipient for $label",
    async ({ mention, resolvedId, expected, lookups }) => {
      let userLookups = 0;
      const api = createXApiClient({
        spend: createXTestSpend(),
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "seed",
        saveRefreshToken: async () => {},
        fetch: async (input) => {
          const url = new URL(input);
          if (url.pathname.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "access" });
          }
          if (url.pathname.startsWith("/2/users/by/username/")) {
            userLookups++;
            return Response.json({ data: { id: resolvedId, username: mention.username } });
          }
          throw new Error("Unexpected X lookup");
        },
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
      expect(result?.post.id).toBe(expected);
      expect(userLookups).toBe(lookups);
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
      const api = createXApiClient({
        spend: createXTestSpend(),
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "seed",
        saveRefreshToken: async () => {},
        fetch: async (input) => {
          const url = new URL(input);
          if (url.pathname.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "access" });
          }
          const id = url.searchParams.get("ids")!;
          requested.push(id);
          return Response.json({
            data:
              id === "20"
                ? [target]
                : [{ id: "10", author_id: quotedAuthor, conversation_id: "10", text: "Original" }],
          });
        },
      });
      const result = await resolveXRecipient({ api, post: "20", userId: "9" });
      expect(result?.post.id).toBe(eligible ? "20" : undefined);
      expect(requested).toEqual(["20", "10"]);
    },
  );
});
