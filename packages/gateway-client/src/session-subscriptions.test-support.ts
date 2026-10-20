import { expect, vi } from "vitest";
import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import {
  GatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageRequestClient,
} from "./session-subscriptions.js";

type SessionRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function createClient(
  handler: SessionRequestHandler = async (method, params) =>
    method === "sessions.messages.subscribe" ? { key: params.key } : {},
) {
  const request = vi.fn(handler);
  const client = {
    request: (method: string, params: Record<string, unknown>) => request(method, params),
  } as unknown as GatewaySessionMessageRequestClient;
  return {
    client,
    request,
    coordinator: new GatewaySessionMessageSubscriptionCoordinator(client),
  };
}

export function expectWire(
  request: ReturnType<typeof createClient>["request"],
  method: "subscribe" | "unsubscribe",
  params: Record<string, unknown> = {},
) {
  expect(request).toHaveBeenLastCalledWith(...wireCall(method, params));
}

function wireCall(method: "subscribe" | "unsubscribe", params: Record<string, unknown>) {
  return [
    `sessions.messages.${method}`,
    { subscriptionId: expect.any(String), key: "main", ...params },
  ] as const;
}

export function expectWireCalls(
  request: ReturnType<typeof createClient>["request"],
  method: "subscribe" | "unsubscribe",
  params: Record<string, unknown>[],
) {
  expect(request.mock.calls.filter(([name]) => name === `sessions.messages.${method}`)).toEqual(
    params.map((fields) => wireCall(method, fields)),
  );
}

export function createStalledRequestClient(stalledMethod: string, stalledKey: string) {
  let shouldStall = true;
  const request = vi.fn(
    (
      method: string,
      params: Record<string, unknown>,
      options?: GatewayProtocolRequestOptions,
    ): Promise<unknown> => {
      if (shouldStall && method === stalledMethod && params.key === stalledKey) {
        shouldStall = false;
        return new Promise((_, reject) => {
          const timeoutMs = options?.timeoutMs;
          if (typeof timeoutMs === "number") {
            setTimeout(
              () =>
                reject(
                  new GatewayProtocolRequestTimeoutError({
                    method,
                    timeoutMs,
                    requestSent: true,
                  }),
                ),
              timeoutMs,
            );
          }
        });
      }
      return Promise.resolve(method === "sessions.messages.subscribe" ? { key: params.key } : {});
    },
  );
  return {
    client: { request } as unknown as GatewaySessionMessageRequestClient,
    request,
  };
}
