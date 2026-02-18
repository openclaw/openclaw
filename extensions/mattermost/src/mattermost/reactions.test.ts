import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { addMattermostReaction, removeMattermostReaction } from "./reactions.js";

function createCfg(): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "test-token",
        baseUrl: "https://chat.example.com",
      },
    },
  };
}

describe("mattermost reactions", () => {
  it("adds reactions by calling /users/me then POST /reactions", async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "BOT123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/v4/reactions")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body)).toEqual({
          user_id: "BOT123",
          post_id: "POST1",
          emoji_name: "thumbsup",
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await addMattermostReaction({
      cfg: createCfg(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns a Result error when add reaction API call fails", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "BOT123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/v4/reactions")) {
        return new Response(JSON.stringify({ id: "err", message: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await addMattermostReaction({
      cfg: createCfg(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mattermost add reaction failed");
    }
  });

  it("removes reactions by calling /users/me then DELETE /users/:id/posts/:postId/reactions/:emoji", async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "BOT123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/v4/users/BOT123/posts/POST1/reactions/thumbsup")) {
        expect(init?.method).toBe("DELETE");
        return new Response(null, {
          status: 204,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await removeMattermostReaction({
      cfg: createCfg(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });
});
