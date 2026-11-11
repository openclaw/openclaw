import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";

export function createSendConfig(
  imessage: NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>,
) {
  return { channels: { imessage } };
}

export function createClient(result: Record<string, unknown>): IMessageRpcClient {
  return {
    request: vi.fn(async () => result),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

export function createRejectingClient(error: Error, onRequest?: () => void): IMessageRpcClient {
  return {
    request: vi.fn(async () => {
      onRequest?.();
      await Promise.resolve();
      throw error;
    }),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

export function createTimedOutSendClient() {
  const requestStarted = createDeferred<void>();
  return {
    client: createRejectingClient(new Error("imsg rpc timeout (send)"), requestStarted.resolve),
    requestStarted: requestStarted.promise,
  };
}

export function getClientMocks(client: IMessageRpcClient): {
  request: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return client as unknown as {
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}
