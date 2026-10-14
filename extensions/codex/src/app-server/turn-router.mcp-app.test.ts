import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import {
  getCodexAppServerTurnRouter,
  hasCodexAppServerSiblingRouteWork,
  type CodexAppServerServerRequest,
} from "./turn-router.js";
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: { warn: vi.fn() },
}));
vi.mock("openclaw/plugin-sdk/extension-shared", () => ({
  createDeferred: () => Promise.withResolvers(),
}));
vi.mock("./event-projector-diagnostics.js", () => ({
  redactCodexEventKind: (value: string) => value,
}));
vi.mock("./protocol-validators.js", () => ({
  readCodexTurnCompletedNotification: () => undefined,
}));
function fixture() {
  let dispatch: (
    request: CodexAppServerServerRequest,
    signal: AbortSignal,
  ) => Promise<unknown> = async () => undefined;
  const client = {
    addNotificationHandler: vi.fn(),
    addRequestHandler: (handler: typeof dispatch) => {
      dispatch = handler;
    },
    addCloseHandler: vi.fn(),
  } as unknown as CodexAppServerClient;
  return {
    client,
    router: getCodexAppServerTurnRouter(client),
    send: (serverName: string, turnId?: string) =>
      dispatch(
        {
          id: "q",
          method: "mcpServer/elicitation/request",
          params: { threadId: "thread", serverName, ...(turnId ? { turnId } : {}) },
        },
        new AbortController().signal,
      ),
  };
}
describe("native manual MCP request routing", () => {
  it("binds no-turn elicitation to the exact server and caller without stealing model requests", async () => {
    const f = fixture();
    const context = new AsyncLocalStorage<string>();
    const model = vi.fn(() => ({ owner: "model" }));
    const route = f.router.reserveThread({ threadId: "thread", onRequest: model });
    route.armTurn();
    await route.bindTurn("turn");
    const ready = Promise.withResolvers<void>();
    const settle = Promise.withResolvers<void>();
    const manual = context.run("alice", () =>
      f.router.withMcpToolCall(
        {
          threadId: "thread",
          serverName: "demo",
          onRequest: () => ({ owner: context.getStore() ?? "missing" }),
        },
        async () => {
          ready.resolve();
          await settle.promise;
        },
      ),
    );
    await ready.promise;
    expect(await f.send("demo")).toEqual({ owner: "alice" });
    expect(await f.send("demo", "turn")).toEqual({ owner: "model" });
    expect(hasCodexAppServerSiblingRouteWork(f.client, "other")).toBe(true);
    await expect(
      f.router.withMcpToolCall(
        { threadId: "thread", serverName: "demo", onRequest: model },
        async () => {},
      ),
    ).rejects.toThrow("already pending");
    settle.resolve();
    await manual;
    route.release();
    expect(await f.send("demo")).toBeUndefined();
    expect(hasCodexAppServerSiblingRouteWork(f.client, "other")).toBe(false);
  });
  it("rejects cancelled calls and does not route another server", async () => {
    const f = fixture();
    const abort = new AbortController();
    const handler = vi.fn(() => ({ action: "accept" }));
    await f.router.withMcpToolCall(
      { threadId: "thread", serverName: "demo", signal: abort.signal, onRequest: handler },
      async () => {
        expect(await f.send("different")).toBeUndefined();
        abort.abort(new Error("revoked"));
        await expect(f.send("demo")).rejects.toThrow("revoked");
      },
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
