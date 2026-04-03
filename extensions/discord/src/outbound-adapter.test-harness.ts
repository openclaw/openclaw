import { expect, vi } from "vitest";

export function createDiscordOutboundHoisted() {
  const sendMessageDiscordMock = vi.fn();
  const sendDiscordComponentMessageMock = vi.fn();
  const sendPollDiscordMock = vi.fn();
  const sendWebhookMessageDiscordMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  return {
    sendMessageDiscordMock,
    sendDiscordComponentMessageMock,
    sendPollDiscordMock,
    sendWebhookMessageDiscordMock,
    getThreadBindingManagerMock,
  };
}

type DiscordSendModule = typeof import("./send.js");
type DiscordSendComponentsModule = typeof import("./send.components.js");
type DiscordThreadBindingsModule = typeof import("./monitor/thread-bindings.js");

export const DEFAULT_DISCORD_SEND_RESULT = {
  channel: "discord",
  messageId: "msg-1",
  channelId: "ch-1",
} as const;

type DiscordOutboundHoisted = ReturnType<typeof createDiscordOutboundHoisted>;

export async function createDiscordSendModuleMock(
  hoisted: DiscordOutboundHoisted,
  importOriginal: () => Promise<DiscordSendModule>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => hoisted.sendMessageDiscordMock(...args),
    sendPollDiscord: (...args: unknown[]) => hoisted.sendPollDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) =>
      hoisted.sendWebhookMessageDiscordMock(...args),
  };
}

export async function createDiscordSendComponentsModuleMock(
  hoisted: DiscordOutboundHoisted,
  importOriginal: () => Promise<DiscordSendComponentsModule>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    sendDiscordComponentMessage: (...args: unknown[]) =>
      hoisted.sendDiscordComponentMessageMock(...args),
  };
}

export async function createDiscordThreadBindingsModuleMock(
  hoisted: DiscordOutboundHoisted,
  importOriginal: () => Promise<DiscordThreadBindingsModule>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    getThreadBindingManager: (...args: unknown[]) => hoisted.getThreadBindingManagerMock(...args),
  };
}

export async function installDiscordOutboundModuleSpies(hoisted: DiscordOutboundHoisted) {
  const sendModule = await import("./send.js");
  const mockedSendModule = await createDiscordSendModuleMock(hoisted, async () => sendModule);
  vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(
    mockedSendModule.sendMessageDiscord,
  );
  vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(mockedSendModule.sendPollDiscord);
  vi.spyOn(sendModule, "sendWebhookMessageDiscord").mockImplementation(
    mockedSendModule.sendWebhookMessageDiscord,
  );

  const sendComponentsModule = await import("./send.components.js");
  const mockedSendComponentsModule = await createDiscordSendComponentsModuleMock(
    hoisted,
    async () => sendComponentsModule,
  );
  vi.spyOn(sendComponentsModule, "sendDiscordComponentMessage").mockImplementation(
    mockedSendComponentsModule.sendDiscordComponentMessage,
  );

  const threadBindingsModule = await import("./monitor/thread-bindings.js");
  const mockedThreadBindingsModule = await createDiscordThreadBindingsModuleMock(
    hoisted,
    async () => threadBindingsModule,
  );
  vi.spyOn(threadBindingsModule, "getThreadBindingManager").mockImplementation(
    mockedThreadBindingsModule.getThreadBindingManager,
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
  });
}
