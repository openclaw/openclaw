import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import * as diagnostics from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./rpc-error.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";

const shared = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  createIsolatedCodexAppServerClient: shared.acquire,
  getLeasedSharedCodexAppServerClient: shared.acquire,
  releaseLeasedSharedCodexAppServerClient: shared.release,
  retireSharedCodexAppServerClientIfCurrent: shared.retire,
}));

const { withCodexAppServerJsonClient } = await import("./request.js");
type LogRecord = Extract<diagnostics.DiagnosticEventPayload, { type: "log.record" }>;
type Options = Parameters<typeof withCodexAppServerJsonClient>[0];
const MESSAGE = "codex app-server scope timed out";
const clientInstanceId = "11111111-1111-4111-8111-111111111111";
const trace = { traceId: "2".repeat(32), spanId: "3".repeat(16) };
let records: LogRecord[];
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetAllMocks();
  diagnostics.resetDiagnosticEventsForTest();
  vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  setLoggerOverride({ level: "warn", consoleLevel: "silent" });
  records = [];
  unsubscribe = diagnostics.onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record" && event.message === MESSAGE) {
      records.push(event);
    }
  });
});

afterEach(async () => {
  await diagnostics.waitForDiagnosticEventsDrained();
  unsubscribe();
  resetLogger();
  diagnostics.resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function client(
  request: (
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown> = async () => ({}),
) {
  return { request, getInstanceId: () => clientInstanceId, closeAndWait: vi.fn(async () => {}) };
}

async function record() {
  await diagnostics.waitForDiagnosticEventsDrained();
  expect(records).toHaveLength(1);
  return records[0]!;
}

function start(run: Parameters<typeof withCodexAppServerJsonClient>[1], options: Options = {}) {
  return withCodexAppServerJsonClient({ timeoutMs: 50, ...options }, run).catch(
    (error: unknown) => error,
  );
}

describe("scoped Codex timeout diagnostics", () => {
  it("reports acquisition without guessing startup, authentication, a client, or a method", async () => {
    const entered = createDeferred<void>();
    const acquired = createDeferred<ReturnType<typeof client>>();
    shared.acquire.mockImplementation(() => {
      entered.resolve();
      return acquired.promise;
    });
    const run = vi.fn(async () => undefined);
    const result = start(run);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ message: "codex app-server request timed out" });
    expect((await record()).attributes).toMatchObject({
      phase: "acquire-client",
      timeoutMs: 50,
      elapsedMs: 50,
      scopeAttemptOrdinal: 1,
      requestStartedCount: 0,
      currentRequestCount: 0,
      currentMethods: "[]",
    });
    expect(records[0]?.attributes).not.toHaveProperty("clientInstanceId");
    expect(shared.acquire.mock.calls[0]?.[0].abandonSignal.aborted).toBe(true);
    acquired.resolve(client());
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    expect(shared.release).toHaveBeenCalledOnce();
  });

  it("retains concurrent awaited methods and the existing trace without retaining payloads", async () => {
    const entered = createDeferred<void>();
    const pending = createDeferred<object>();
    const privateText = "synthetic-private-prompt-token-environment";
    let started = 0;
    const request = vi.fn(
      (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
        if (++started === 5) {
          entered.resolve();
        }
        return method === "account/read" ? Promise.resolve({}) : pending.promise;
      },
    );
    shared.acquire.mockResolvedValue(client(request));
    const result = runWithDiagnosticTraceContext(trace, () =>
      start(
        async (send) => {
          const calls = ["app/read", "model/list", "app/read", "account/read", privateText].map(
            (method) =>
              send({ method, requestParams: { prompt: privateText, token: privateText } }),
          );
          return await Promise.all(calls);
        },
        { sessionId: privateText, sessionKey: privateText },
      ),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ message: "codex app-server request timed out" });
    const logged = await record();
    expect(logged.trace).toMatchObject(trace);
    expect(logged.attributes).toMatchObject({
      phase: "client-request",
      clientInstanceId,
      requestStartedCount: 5,
      currentRequestCount: 4,
      currentMethods: '[["app/read",2],["model/list",1],["other",1]]',
      omittedMethodCount: 0,
    });
    expect(JSON.stringify(logged)).not.toContain(privateText);
    expect(JSON.stringify(logged)).not.toContain("account/read");
    expect(logged.attributes).not.toHaveProperty("runId");
    expect(logged.attributes).not.toHaveProperty("rpcId");
    expect(request.mock.calls.every((call) => call[2]?.signal?.aborted)).toBe(true);
    pending.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.release).toHaveBeenCalledOnce();
    expect(shared.retire).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
  });

  it.each(["before timeout", "after timeout"] as const)(
    "preserves the acquisition boundary when cleanup starts %s",
    async (ordering) => {
      const entered = createDeferred<CodexAppServerClientOptions>();
      const finish = createDeferred<ReturnType<typeof client>>();
      shared.acquire.mockImplementation((options: CodexAppServerClientOptions) => {
        options.onAcquireObservation?.({ boundary: "initialize", startup: "created-shared" });
        entered.resolve(options);
        return finish.promise;
      });
      const result = start(async () => undefined);
      const options = await entered.promise;
      if (ordering === "before timeout") {
        options.onAcquireObservation?.({ boundary: "cleanup" });
        options.onAcquireObservation?.({ boundary: "cleanup" });
      }
      await vi.advanceTimersByTimeAsync(50);
      await result;
      const logged = await record();
      if (ordering === "before timeout") {
        expect(logged.attributes).toMatchObject({
          acquireLastObservedBoundary: "cleanup",
          acquireBoundaryBeforeCleanup: "initialize",
        });
      } else {
        options.onAcquireObservation?.({ boundary: "cleanup" });
        expect(logged.attributes).toMatchObject({ acquireLastObservedBoundary: "initialize" });
        expect(logged.attributes).not.toHaveProperty("acquireBoundaryBeforeCleanup");
      }
      finish.resolve(client());
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each(["resolved", "rejected"] as const)(
    "does not retain a %s method while the callback continues",
    async (outcome) => {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const request = vi.fn(async () => {
        if (outcome === "rejected") {
          throw new Error("synthetic-private-error");
        }
        return {};
      });
      shared.acquire.mockResolvedValue(client(request));
      const result = start(async (send) => {
        await send({ method: "account/read" }).catch(() => undefined);
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      await result;
      const logged = await record();
      expect(logged.attributes).toMatchObject({
        phase: "callback",
        clientInstanceId,
        requestStartedCount: 1,
        currentRequestCount: 0,
        currentMethods: "[]",
      });
      expect(JSON.stringify(logged)).not.toContain("account/read");
      expect(JSON.stringify(logged)).not.toContain("synthetic-private-error");
      expect(logged.trace).toBeUndefined();
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(shared.release).toHaveBeenCalledOnce();
    },
  );

  it("bounds method detail without losing the outstanding request count", async () => {
    const entered = createDeferred<void>();
    const finish = createDeferred<object>();
    shared.acquire.mockResolvedValue(client(() => finish.promise));
    const methods = [
      "account/read",
      "app/read",
      "app/list",
      "model/list",
      "thread/list",
      "thread/read",
      "plugin/read",
      "plugin/list",
      "skills/list",
      "hooks/list",
    ];
    const result = start(async (send) => {
      const calls = methods.map((method) => send({ method }));
      entered.resolve();
      return await Promise.all(calls);
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    const fields = (await record()).attributes!;
    expect(fields.currentRequestCount).toBe(10);
    expect(fields.omittedMethodCount).toBe(2);
    expect(JSON.parse(String(fields.currentMethods))).toHaveLength(8);
    finish.resolve({});
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reports release separately and preserves isolated shutdown budgets", async () => {
    const closing = createDeferred<void>();
    const finish = createDeferred<void>();
    const acquired = client();
    acquired.closeAndWait.mockImplementation(async () => {
      closing.resolve();
      await finish.promise;
    });
    shared.acquire.mockResolvedValue(acquired);
    const result = start(async (send) => send({ method: "model/list" }), {
      isolated: true,
      timeoutMessage: "custom timeout",
      isolatedShutdown: { exitTimeoutMs: 200, forceKillDelayMs: 300 },
    });
    await closing.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ message: "custom timeout" });
    expect((await record()).attributes).toMatchObject({
      phase: "release-client",
      currentRequestCount: 0,
      currentMethods: "[]",
    });
    expect(acquired.closeAndWait).toHaveBeenCalledExactlyOnceWith({
      exitTimeoutMs: 200,
      forceKillDelayMs: 300,
    });
    expect(shared.release).not.toHaveBeenCalled();
    finish.resolve();
  });

  it.each(["available", "unavailable", "throwing"] as const)(
    "preserves initialize evidence when registered transport identity is %s",
    async (mode) => {
      const entered = createDeferred<void>();
      const acquired = createDeferred<ReturnType<typeof client>>();
      const identity = { pid: 500002, startedAt: "fixture-boot:12345" };
      const started = {
        ...client(),
        getInitializeDiagnostic: () => ({ boundary: "request", outcome: "pending" }),
        getRegisteredTransportIdentity: () => {
          if (mode === "throwing") {
            throw new Error("private diagnostic failure");
          }
          return mode === "available" ? identity : undefined;
        },
      };
      shared.acquire.mockImplementation((options: CodexAppServerClientOptions) => {
        options.onStartedClient?.({
          ...started,
          getRegisteredTransportIdentity: () => ({ pid: 500001, startedAt: "previous-child" }),
        } as never);
        options.onStartedClient?.(started as never);
        identity.pid = 500003;
        entered.resolve();
        return acquired.promise;
      });
      const result = start(async () => undefined);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ message: "codex app-server request timed out" });
      const logged = await record();
      expect(logged.attributes).toMatchObject({
        lastStartedClientInstanceId: clientInstanceId,
        lastStartedTransportIdentity:
          mode === "available"
            ? JSON.stringify({ pid: 500002, startedAt: "fixture-boot:12345" })
            : "unavailable",
      });
      expect(JSON.parse(String(logged.attributes?.initializeSnapshot))).toEqual({
        boundary: "request",
        outcome: "pending",
      });
      expect(JSON.stringify(logged)).not.toContain("private diagnostic failure");
      acquired.resolve(client());
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("keeps the default 60 second whole-scope deadline", async () => {
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    shared.acquire.mockResolvedValue(client());
    const result = withCodexAppServerJsonClient({}, async () => {
      entered.resolve();
      await finish.promise;
    }).catch((error: unknown) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(records).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ message: "codex app-server request timed out" });
    expect((await record()).attributes).toMatchObject({ timeoutMs: 60_000, elapsedMs: 60_000 });
    finish.resolve();
  });

  it.each(["disabled", "throwing sink"] as const)(
    "keeps timeout and abandonment semantics with %s diagnostics",
    async (mode) => {
      if (mode === "disabled") {
        vi.mocked(diagnostics.areDiagnosticsEnabledForProcess).mockReturnValue(false);
      } else {
        vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {
          throw new Error("sink");
        });
      }
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      shared.acquire.mockResolvedValue(client());
      const result = start(async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ message: "codex app-server request timed out" });
      expect(shared.acquire.mock.calls[0]?.[0].abandonSignal.aborted).toBe(true);
      expect(records).toEqual([]);
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(shared.release).toHaveBeenCalledOnce();
    },
  );

  it("preserves RPC errors and caller cancellation without emitting a timeout", async () => {
    const error = new CodexAppServerRpcError(
      { code: -32601, message: "unsupported" },
      "model/list",
    );
    shared.acquire.mockResolvedValue(
      client(
        vi.fn(async () => {
          throw error;
        }),
      ),
    );
    expect(await start(async (send) => send({ method: "model/list" }))).toBe(error);
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    controller.abort(cancelled);
    expect(await start(async () => undefined, { signal: controller.signal })).toBe(cancelled);
    expect(records).toEqual([]);
    expect(shared.acquire).toHaveBeenCalledOnce();
    expect(shared.release).toHaveBeenCalledOnce();
  });
});
