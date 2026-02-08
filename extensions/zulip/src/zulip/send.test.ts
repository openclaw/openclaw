import { describe, expect, it, vi } from "vitest";

// Mock runtime/config so sendMessageZulip can resolve a client.
vi.mock("../runtime.js", () => {
  return {
    getZulipRuntime: () => ({
      config: {
        loadConfig: () => ({
          channels: {
            zulip: {
              enabled: true,
              realm: "https://zulip.example.com",
              email: "bot@example.com",
              apiKey: "x",
            },
          },
        }),
      },
    }),
  };
});

const mocks = vi.hoisted(() => {
  return {
    resolveUserIdsForEmails: vi.fn(async () => [42]),
    zulipSendMessage: vi.fn(async () => ({ id: 123 })),
  };
});

vi.mock("./users.js", () => ({
  resolveUserIdsForEmails: mocks.resolveUserIdsForEmails,
}));

vi.mock("./client.js", async (importOriginal) => {
  // Keep other exports (types/helpers) intact.
  const mod = await importOriginal();
  return { ...(mod as object), zulipSendMessage: mocks.zulipSendMessage };
});

import { sendMessageZulip } from "./send.js";

describe("sendMessageZulip", () => {
  it("uses resolved numeric user_id list for PMs (not raw emails)", async () => {
    const result = await sendMessageZulip("pm:delivery@example.com", "hello");
    expect(result.ok).toBe(true);

    expect(mocks.resolveUserIdsForEmails).toHaveBeenCalledWith(expect.any(Object), [
      "delivery@example.com",
    ]);

    expect(mocks.zulipSendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: "private",
        to: [42],
        content: "hello",
      }),
    );
  });
});
