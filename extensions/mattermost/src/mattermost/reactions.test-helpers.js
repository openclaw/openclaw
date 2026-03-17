import { expect, vi } from "vitest";
function createMattermostTestConfig() {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "test-token",
        baseUrl: "https://chat.example.com"
      }
    }
  };
}
function createMattermostReactionFetchMock(params) {
  const userId = params.userId ?? "BOT123";
  const mode = params.mode;
  const allowAdd = mode === "add" || mode === "both";
  const allowRemove = mode === "remove" || mode === "both";
  const addStatus = params.status ?? 201;
  const removeStatus = params.status ?? 204;
  const removePath = `/api/v4/users/${userId}/posts/${params.postId}/reactions/${encodeURIComponent(params.emojiName)}`;
  return vi.fn(async (url, init) => {
    if (String(url).endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: userId }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (allowAdd && String(url).endsWith("/api/v4/reactions")) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body)).toEqual({
        user_id: userId,
        post_id: params.postId,
        emoji_name: params.emojiName
      });
      const responseBody = params.body === void 0 ? { ok: true } : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null ? { status: addStatus, headers: { "content-type": "text/plain" } } : { status: addStatus, headers: { "content-type": "application/json" } }
      );
    }
    if (allowRemove && String(url).endsWith(removePath)) {
      expect(init?.method).toBe("DELETE");
      const responseBody = params.body === void 0 ? null : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null ? { status: removeStatus, headers: { "content-type": "text/plain" } } : { status: removeStatus, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected url: ${url}`);
  });
}
async function withMockedGlobalFetch(fetchImpl, run) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = prevFetch;
  }
}
export {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch
};
