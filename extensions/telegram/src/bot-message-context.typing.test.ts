import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext typing", () => {
  it("sends direct typing before session context construction", async () => {
    const buildInboundContext = vi.fn(buildChannelInboundEventContext);
    const sendChatAction = vi.fn(async () => undefined);

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        sendChatActionHandler: { sendChatAction },
        sessionRuntime: {
          buildChannelInboundEventContext: buildInboundContext,
        },
      }),
    ).resolves.not.toBeNull();

    expect(sendChatAction).toHaveBeenCalledWith(42, "typing", undefined);
    expect(sendChatAction.mock.invocationCallOrder[0]).toBeLessThan(
      buildInboundContext.mock.invocationCallOrder[0],
    );
  });

  it("does not send early direct typing before DM access passes", async () => {
    const sendChatAction = vi.fn(async () => undefined);

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        cfg: {
          agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
          channels: { telegram: { dmPolicy: "disabled", allowFrom: [] } },
          messages: { groupChat: { mentionPatterns: [] } },
        },
        dmPolicy: "disabled",
        sendChatActionHandler: { sendChatAction },
      }),
    ).resolves.toBeNull();

    expect(sendChatAction).not.toHaveBeenCalled();
  });
});
