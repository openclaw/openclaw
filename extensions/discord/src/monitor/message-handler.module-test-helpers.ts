import { vi } from "vitest";
import type { MockFn } from "../../../../src/test-utils/vitest-mock-fn.js";

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
