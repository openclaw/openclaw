import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();
export const deliverDiscordReplyMock: MockFn = vi.fn(async () => undefined);

const { createDiscordMessageHandler: createRealDiscordMessageHandler } =
  await import("./message-handler.js");

export function createDiscordMessageHandler(
  ...args: Parameters<typeof createRealDiscordMessageHandler>
) {
  const [params] = args;
  return createRealDiscordMessageHandler({
    ...params,
    __testing: {
      ...params.__testing,
      preflightDiscordMessage: preflightDiscordMessageMock,
      processDiscordMessage: processDiscordMessageMock,
      deliverDiscordReply: deliverDiscordReplyMock,
    },
  });
}
