import { afterEach, expect, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";
import { waitForResponse } from "./turn-router.test-support.js";

type RouteHandlers = Omit<
  Parameters<ReturnType<typeof getCodexAppServerTurnRouter>["reserveThread"]>[0],
  "threadId"
>;

export const unhandledToolResult = {
  contentItems: [
    {
      type: "inputText",
      text: "OpenClaw did not register a handler for this app-server tool call.",
    },
  ],
  success: false,
};

export function completedNotification(threadId: string, turnId: string, status = "completed") {
  return {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status, items: [] } },
  };
}

export function expectDelivery(
  handler: unknown,
  notification: CodexServerNotification,
  scope: { threadId: string; turnId?: string },
  correlation: { threadId?: string; turnId?: string; completedTurn?: unknown } = scope,
) {
  expect(handler).toHaveBeenCalledWith(
    { ...notification, completedTurn: undefined, ...correlation },
    scope,
  );
}

export function useRouterHarness() {
  const clients: CodexAppServerClient[] = [];
  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  return (threadId = "thread-1", turnId = "turn-1") => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const notify = (method: string, params: JsonObject) => harness.send({ method, params });
    const request = (id: string, method: string, params: JsonObject) =>
      harness.send({ id, method, params });
    return {
      ...harness,
      get router() {
        return getCodexAppServerTurnRouter(harness.client);
      },
      reserve: (handlers: RouteHandlers = {}) =>
        getCodexAppServerTurnRouter(harness.client).reserveThread({ threadId, ...handlers }),
      notify,
      request,
      turn: (method: string, params: JsonObject = {}) =>
        notify(method, { threadId, turnId, ...params }),
      call: (id: string, method: string, params: JsonObject = {}) =>
        request(id, method, { threadId, turnId, ...params }),
      complete: (id = turnId) => harness.send(completedNotification(threadId, id)),
      watch: (watchedTurnId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
        getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
          threadId,
          turnId: watchedTurnId,
          timeoutMs: 100,
          ...options,
        }),
      expectResponse: async (id: string, result: unknown) =>
        expect(await waitForResponse(harness, id)).toEqual({ id, result }),
    };
  };
}
