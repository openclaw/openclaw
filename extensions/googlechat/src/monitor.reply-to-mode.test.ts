import type { OpenClawConfig, PluginRuntime, ResolvedGoogleChatAccount } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it, vi } from "vitest";

const sendGoogleChatMessage = vi.fn();
const updateGoogleChatMessage = vi.fn();
const deleteGoogleChatMessage = vi.fn();
const uploadGoogleChatAttachment = vi.fn();

vi.mock("./api.js", () => ({
  sendGoogleChatMessage: (...args: unknown[]) => sendGoogleChatMessage(...args),
  updateGoogleChatMessage: (...args: unknown[]) => updateGoogleChatMessage(...args),
  deleteGoogleChatMessage: (...args: unknown[]) => deleteGoogleChatMessage(...args),
  uploadGoogleChatAttachment: (...args: unknown[]) => uploadGoogleChatAttachment(...args),
}));

describe("googlechat monitor replyToMode", () => {
  it("does not force thread replies when replyToMode is off", async () => {
    const { __testDeliverGoogleChatReply } = await import("./monitor.js");

    sendGoogleChatMessage.mockResolvedValue({});
    updateGoogleChatMessage.mockResolvedValue({});
    deleteGoogleChatMessage.mockResolvedValue({});

    const account = {
      accountId: "default",
      enabled: true,
      config: {},
    } as ResolvedGoogleChatAccount;

    const core = {
      channel: {
        media: { fetchRemoteMedia: vi.fn(), saveMediaBuffer: vi.fn() },
        text: {
          resolveChunkMode: vi.fn(() => "paragraph"),
          chunkMarkdownTextWithMode: vi.fn(() => ["hello"]),
        },
      },
    } as unknown as PluginRuntime;

    await __testDeliverGoogleChatReply({
      payload: { text: "hello", replyToId: "spaces/AAA/threads/BBB" },
      account,
      spaceId: "spaces/AAA",
      runtime: { error: vi.fn() } as any,
      core: core as any,
      config: { channels: { googlechat: { replyToMode: "off" } } } as OpenClawConfig,
    });

    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "hello",
        thread: undefined,
      }),
    );
  });
});
