import { vi } from "vitest";
import type { handleBrowserGatewayRequest } from "./browser-request.js";

type Request = Parameters<typeof handleBrowserGatewayRequest>[0];
export function deferredOperation<T>() {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<T>();
  return {
    entered: entered.promise,
    resolve: result.resolve,
    run: () => {
      entered.resolve();
      return result.promise;
    },
  };
}

export function makeRequest(params: Request["params"], overrides: Partial<Request> = {}) {
  return {
    params,
    respond: vi.fn<Request["respond"]>(),
    context: { nodeRegistry: { listConnected: () => [] } } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
    ...overrides,
  } satisfies Request;
}

export function makeClient(
  connectionSignal: AbortSignal,
  connId = "requester-1",
): NonNullable<Request["client"]> {
  return {
    connId,
    connectionSignal,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
    },
  };
}
