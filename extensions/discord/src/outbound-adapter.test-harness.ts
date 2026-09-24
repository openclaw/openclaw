// Discord plugin module implements outbound adapter harness behavior.
import { expect, vi, type Mock } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

type DiscordOutboundHoisted = {
  sendMessageDiscordMock: AsyncUnknownMock;
  sendDiscordComponentMessageMock: AsyncUnknownMock;
  sendPollDiscordMock: AsyncUnknownMock;
  sendWebhookMessageDiscordMock: AsyncUnknownMock;
  sendVoiceMessageDiscordMock: AsyncUnknownMock;
  getThreadBindingManagerMock: UnknownMock;
};

type DiscordSendModule = typeof import("./send.js");
type DiscordSendComponentsModule = typeof import("./send.components.js");
type DiscordThreadBindingsModule = typeof import("./monitor/thread-bindings.js");

export function createDiscordOutboundHoisted(): DiscordOutboundHoisted {
  const sendMessageDiscordMock = vi.fn();
  const sendDiscordComponentMessageMock = vi.fn();
  const sendPollDiscordMock = vi.fn();
  const sendWebhookMessageDiscordMock = vi.fn();
  const sendVoiceMessageDiscordMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  return {
    sendMessageDiscordMock,
    sendDiscordComponentMessageMock,
    sendPollDiscordMock,
    sendWebhookMessageDiscordMock,
    sendVoiceMessageDiscordMock,
    getThreadBindingManagerMock,
  };
}

const DEFAULT_DISCORD_SEND_RESULT = {
  channel: "discord",
  messageId: "msg-1",
  target: { kind: "channel", id: "ch-1" },
} as const;

export async function installDiscordOutboundModuleSpies(hoisted: DiscordOutboundHoisted) {
  const sendModule = await import("./send.js");
  vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(
    (...args) =>
      hoisted.sendMessageDiscordMock(...args) as ReturnType<
        DiscordSendModule["sendMessageDiscord"]
      >,
  );
  vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(
    (...args) =>
      hoisted.sendPollDiscordMock(...args) as ReturnType<DiscordSendModule["sendPollDiscord"]>,
  );
  vi.spyOn(sendModule, "sendWebhookMessageDiscord").mockImplementation(
    (...args) =>
      hoisted.sendWebhookMessageDiscordMock(...args) as ReturnType<
        DiscordSendModule["sendWebhookMessageDiscord"]
      >,
  );
  vi.spyOn(sendModule, "sendVoiceMessageDiscord").mockImplementation(
    (...args) =>
      hoisted.sendVoiceMessageDiscordMock(...args) as ReturnType<
        DiscordSendModule["sendVoiceMessageDiscord"]
      >,
  );

  const sendComponentsModule = await import("./send.components.js");
  vi.spyOn(sendComponentsModule, "sendDiscordComponentMessage").mockImplementation(
    (...args) =>
      hoisted.sendDiscordComponentMessageMock(...args) as ReturnType<
        DiscordSendComponentsModule["sendDiscordComponentMessage"]
      >,
  );

  const threadBindingsModule = await import("./monitor/thread-bindings.js");
  vi.spyOn(threadBindingsModule, "getThreadBindingManager").mockImplementation(
    (...args) =>
      hoisted.getThreadBindingManagerMock(...args) as ReturnType<
        DiscordThreadBindingsModule["getThreadBindingManager"]
      >,
  );
}

export function resetDiscordOutboundMocks(hoisted: DiscordOutboundHoisted) {
  hoisted.sendMessageDiscordMock.mockReset().mockResolvedValue({
    messageId: "msg-1",
    channelId: "ch-1",
  });
  hoisted.sendDiscordComponentMessageMock.mockReset().mockResolvedValue({
    messageId: "component-1",
    channelId: "ch-1",
  });
  hoisted.sendPollDiscordMock.mockReset().mockResolvedValue({
    messageId: "poll-1",
    channelId: "ch-1",
  });
  hoisted.sendWebhookMessageDiscordMock.mockReset().mockResolvedValue({
    messageId: "msg-webhook-1",
    channelId: "thread-1",
  });
  hoisted.sendVoiceMessageDiscordMock.mockReset().mockResolvedValue({
    messageId: "voice-1",
    channelId: "ch-1",
  });
  hoisted.getThreadBindingManagerMock.mockReset().mockReturnValue(null);
}

export function expectDiscordThreadBotSend(params: {
  hoisted: DiscordOutboundHoisted;
  text: string;
  result: unknown;
  options?: Record<string, unknown>;
}) {
  expect(params.hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
    "channel:thread-1",
    params.text,
    expect.objectContaining({
      accountId: "default",
      ...params.options,
    }),
  );
  expect(params.result).toEqual(DEFAULT_DISCORD_SEND_RESULT);
}

export function mockDiscordBoundThreadManager(hoisted: DiscordOutboundHoisted) {
  hoisted.getThreadBindingManagerMock.mockReturnValue({
    getByThreadId: () => ({
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "codex-thread",
      webhookId: "wh-1",
      webhookToken: "tok-1",
      boundBy: "system",
      boundAt: Date.now(),
    }),
    touchThread: vi.fn(),
  });
}
