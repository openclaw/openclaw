import { expect, it, vi } from "vitest";
import { telegramMessageActions } from "./channel-actions.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/channel-outbound", async (load) => ({
  ...(await load<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  sendDurableMessageBatch: capture,
}));

it.each([true, false])(
  "keeps the transcript producer separate from policy (source present: %s)",
  async (present) => {
    capture.mockResolvedValue({ status: "suppressed", reason: "empty" });
    await telegramMessageActions.handleAction!({
      channel: "telegram",
      action: "send",
      cfg: { channels: { telegram: { botToken: "123:fixture" } } },
      sessionKey: "agent:main:policy",
      ...(present ? { transcriptProducerSessionKey: "agent:main:main" } : {}),
      params: { to: "123", message: "hello", transcriptProducerSessionKey: "agent:main:forged" },
    });
    const { session } = capture.mock.lastCall![0];
    expect(session.key).toBe("agent:main:policy");
    expect(session.transcriptProducerKey).toBe(present ? "agent:main:main" : undefined);
  },
);
