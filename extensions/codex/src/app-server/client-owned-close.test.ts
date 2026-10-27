import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerCloseResult } from "./transport.js";

const close = vi.hoisted(() => ({ physical: vi.fn(), local: vi.fn() }));
// This close-only fixture never starts, decodes, or handles an RPC. Keep those
// unrelated owners from importing compiled workers and the shared-client graph.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  OPENCLAW_VERSION: "test",
  embeddedAgentLog: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./config-runtime.js", () => ({ resolveCodexAppServerRuntimeOptions: vi.fn() }));
vi.mock("./transport-stdio.js", () => ({ createStdioTransport: vi.fn() }));
vi.mock("./transport-websocket.js", () => ({ createWebSocketTransport: vi.fn() }));
vi.mock("./client-catalog-worker.js", () => ({
  CodexCatalogWorker: class {
    close() {
      return close.local();
    }
  },
  codexCatalogRequestId: vi.fn(),
}));
vi.mock("./server-requests.js", () => ({
  CodexServerRequests: class {
    close() {
      return Promise.resolve();
    }
  },
}));
vi.mock("./transport.js", () => ({
  closeCodexAppServerTransport: vi.fn(),
  closeCodexAppServerTransportAndWait: close.physical,
  hasCodexAppServerNaturalExit: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("joins owned physical exit before reporting local cleanup failure", async () => {
  vi.useFakeTimers();
  let exited!: (result: CodexAppServerCloseResult) => void;
  const physical = new Promise<CodexAppServerCloseResult>((resolve) => {
    exited = resolve;
  });
  const failure = new Error("local cleanup failed");
  close.physical.mockReturnValue(physical);
  close.local.mockRejectedValue(failure);
  const transport = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const client = CodexAppServerClient.fromTransportForTests(transport);
  const settled = vi.fn();
  const closing = client.closeAndWait({ terminateOwnedProcess: true });
  void closing.then(settled, settled);
  const rejected = expect(closing).rejects.toBe(failure);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(close.local).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    exited({ exited: true, cleanup: "closed" });
    await rejected;
    expect(settled).toHaveBeenCalledExactlyOnceWith(failure);
    expect(close.physical).toHaveBeenCalledWith(transport, { terminateOwnedProcess: true });
  } finally {
    exited({ exited: true, cleanup: "closed" });
    await closing.catch(() => {});
    transport.stdin.destroy();
    transport.stdout.destroy();
    transport.stderr.destroy();
  }
});
