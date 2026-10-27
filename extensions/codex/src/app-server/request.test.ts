import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { isNativeError } from "node:util/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexControlRequest } from "../command-rpc.js";
import type {
  CodexControlRequestFailureCategory,
  CodexControlRequestPhase,
} from "./request-observation.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";
const shared = vi.hoisted(() => ({
  isolated: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  retire: vi.fn(),
}));

// mock-isolation: Quota notifications belong to live leases; this suite exercises isolated fallback.
vi.mock("./shared-client-usage.js", () => ({
  readSharedCodexAppServerUsage: vi.fn(async () => undefined),
}));

// mock-isolation: Requests use fixture-owned clients, never process-global shared leases.
vi.mock("./shared-client.js", () => ({
  createIsolatedCodexAppServerClient: shared.isolated,
  getSharedCodexAppServerClient: shared.acquire,
  getLeasedSharedCodexAppServerClient: shared.acquire,
  releaseLeasedSharedCodexAppServerClient: shared.release,
  retireSharedCodexAppServerClientIfCurrent: shared.retire,
}));

const {
  CodexAppServerScopedRequestRejectedError,
  readCodexAppServerUsage,
  requestCodexAppServerClientJson,
  requestCodexAppServerJson,
  withCodexAppServerJsonClient,
} = await import("./request.js");
const { listAllCodexAppServerModels } = await import("./models.js");

const listRequest = (options: Partial<Parameters<typeof requestCodexAppServerJson>[0]> = {}) =>
  requestCodexAppServerJson({ method: "thread/list", requestParams: {}, ...options });

const controlObservation = { phase: vi.fn(), failed: vi.fn() };
function expectFailure(
  phase: CodexControlRequestPhase,
  category: CodexControlRequestFailureCategory = "other",
) {
  expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({ phase, category });
}
function isolatedClient(
  request = vi.fn(),
  closeAndWait = vi.fn<() => Promise<void>>(async () => {}),
) {
  shared.isolated.mockResolvedValue({ request, closeAndWait });
  return { request, closeAndWait };
}
const sandboxPolicy = {
  config: { agents: { defaults: { sandbox: { mode: "all" as const } } } },
  sessionKey: "sandboxed-session",
};
const nodePolicy = {
  config: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
  sessionKey: "node-session",
};
const sandboxEnvironment = {
  cwd: "/workspace",
  environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
};
function deferAcquisition<T>(once = true) {
  const entered = createDeferred<void>();
  const acquisition = createDeferred<T>();
  shared.acquire[once ? "mockImplementationOnce" : "mockImplementation"](() => {
    entered.resolve();
    return acquisition.promise;
  });
  return { entered, acquisition };
}

describe("requestCodexAppServerJson sandbox guard", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-preflight-");
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    for (const mock of [...Object.values(shared), ...Object.values(controlObservation)]) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects a native write when the selected session changes during async admission", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:async-native-admission";
    const selection = { agentId: "main", storePath, sessionKey };
    const replace = (sessionId: string, updatedAt: number) =>
      upsertSessionEntry({ ...selection, entry: { sessionId, updatedAt } });
    await replace("first-session", 1);
    const selected = await captureSessionEntryCurrentCheckAsync(selection);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const harness = createClientHarness();
    try {
      const request = requestCodexAppServerClientJson({
        client: harness.client,
        method: "thread/list",
        requestParams: {},
        assertCurrentAsync: async () => {
          entered.resolve();
          await resume.promise;
          await selected.assertCurrent();
        },
      });
      const rejected = expect(request).rejects.toThrow();
      await entered.promise;
      await replace("replacement-session", 2);
      resume.resolve();
      await rejected;
      expect(harness.writes).toEqual([]);
    } finally {
      resume.resolve();
      harness.client.close();
    }
  });

  it.each([
    ["sandbox", "command/exec"],
    ["node", "command/exec"],
    ["node", "process/spawn"],
    ["sandbox", "app/activate"],
    ["node", "app/activate"],
    ["sessionless", "command/exec"],
    ["sessionless", "config/mcpServer/reload"],
    ["nodeSandbox", "thread/start"],
  ] as const)("fails closed before acquisition: %s %s", async (scope, method) => {
    const policies = {
      sandbox: sandboxPolicy,
      node: nodePolicy,
      sessionless: { config: nodePolicy.config },
      nodeSandbox: { ...nodePolicy, config: { ...sandboxPolicy.config, ...nodePolicy.config } },
    };
    const requestParams =
      method === "thread/start"
        ? sandboxEnvironment
        : method === "app/activate" || method === "config/mcpServer/reload"
          ? {}
          : { command: ["sh", "-lc", "id"] };
    const reason = scope === "sandbox" ? "OpenClaw sandboxing" : "OpenClaw exec host=node";
    await expect(
      requestCodexAppServerJson({ method, requestParams, ...policies[scope] }),
    ).rejects.toThrow(
      `Codex-native app-server method \`${method}\` is unavailable because ${reason} is active for this session.`,
    );
    expect(shared.acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["thread/list", { limit: 10 }, true],
    ["thread/start", sandboxEnvironment, false],
  ] as const)("allows %s under its execution policies", async (method, requestParams, alsoNode) => {
    const response = { ok: true };
    shared.acquire.mockResolvedValue({ request: vi.fn(async () => response) });
    const policies = alsoNode ? [sandboxPolicy, nodePolicy] : [sandboxPolicy];
    for (const policy of policies) {
      await expect(
        requestCodexAppServerJson({ method, requestParams, ...policy }),
      ).resolves.toEqual(response);
    }
  });

  it.each([
    ["client-request", -32601, "rpc-method-unavailable"],
    ["client-request", -32603, "rpc-error"],
    ["client-request", null, "other"],
    ["acquire-client", null, "other"],
  ] as const)("preserves %s errors (%s) and reports %s", async (phase, code, category) => {
    const error =
      code === null
        ? new Error("private-error")
        : new CodexAppServerRpcError({ code, message: "private-rpc" }, "thread/list");
    if (phase === "acquire-client") {
      shared.acquire.mockRejectedValue(error);
    } else {
      shared.acquire.mockResolvedValue({ request: vi.fn().mockRejectedValue(error) });
    }
    await expect(listRequest({ controlObservation })).rejects.toBe(error);
    expectFailure(phase, category);
    expect(shared.release).toHaveBeenCalledTimes(phase === "acquire-client" ? 0 : 1);
    if (phase === "acquire-client") {
      expect(controlObservation.phase).not.toHaveBeenCalledWith("client-request");
    }
    expect(JSON.stringify(controlObservation.failed.mock.calls)).not.toContain("private-");
  });

  it.each([
    ["acquired", "thread/list"],
    ["owned", "thread/list"],
    ["acquired", "model/list"],
    ["owned", "model/list"],
  ] as const)(
    "forwards only the catalog callback for an %s client and %s",
    async (owner, method) => {
      const harness = createClientHarness({
        autoEmitExit: false,
        onWrite(line, send) {
          const frame = JSON.parse(line) as { id: number };
          expect(frame).toEqual({ id: expect.any(Number), method, params: {} });
          send({ id: frame.id, result: { data: [] } });
        },
      });
      const attemptWaiterFinished = vi.fn();
      const callbackObservation = { phase: vi.fn(), failed: vi.fn(), attemptWaiterFinished };
      shared.acquire.mockResolvedValue(harness.client);
      try {
        const params = { method, requestParams: {}, controlObservation: callbackObservation };
        const result =
          owner === "owned"
            ? requestCodexAppServerClientJson({ ...params, client: harness.client })
            : requestCodexAppServerJson(params);
        await expect(result).resolves.toEqual({ data: [] });
        if (method === "thread/list") {
          expect(attemptWaiterFinished).toHaveBeenCalledOnce();
        } else {
          expect(attemptWaiterFinished).not.toHaveBeenCalled();
        }
        if (owner === "owned") {
          expect(shared.acquire).not.toHaveBeenCalled();
        }
      } finally {
        harness.client.close();
        harness.emitExit();
      }
    },
  );

  it.each(["request", "cleanup", "deadline"] as const)(
    "reports the escaping failure when cleanup ends with %s",
    async (outcome) => {
      vi.useFakeTimers();
      const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
      const requestError = new Error("private-request-error");
      const cleanupError = new Error("private-cleanup-error");
      const { closeAndWait } = isolatedClient(
        vi.fn().mockRejectedValue(requestError),
        vi.fn(async () => {
          if (outcome === "cleanup") {
            throw cleanupError;
          }
          if (outcome === "deadline") {
            elapsed.mockReturnValue(51);
          }
        }),
      );
      const rejected = expect(
        listRequest({
          timeoutMs: 50,
          isolated: true,
          controlObservation,
        }),
      ).rejects;
      if (outcome === "deadline") {
        await rejected.toMatchObject({
          message: "codex app-server thread/list timed out",
          cause: requestError,
        });
      } else {
        await rejected.toBe(outcome === "cleanup" ? cleanupError : requestError);
      }
      expectFailure(
        outcome === "request" ? "client-request" : "release-client",
        outcome === "deadline" ? "deadline-observed" : "other",
      );
      expect(closeAndWait).toHaveBeenCalledExactlyOnceWith({
        exitTimeoutMs: 2_000,
        forceKillDelayMs: 250,
      });
    },
  );

  it("does not claim API entry when argument evaluation expires the budget before the later deadline decision", async () => {
    vi.useFakeTimers();
    const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const request = vi.fn();
    shared.acquire.mockResolvedValue({ request });
    await expect(
      withCodexAppServerJsonClient({ timeoutMs: 50, controlObservation }, async (send) => {
        return await send({
          method: "thread/list",
          get requestParams() {
            elapsedClock.mockReturnValue(51);
            return {};
          },
        });
      }),
    ).rejects.toThrow("codex app-server request timed out");
    expect(request).not.toHaveBeenCalled();
    expect(controlObservation.phase).not.toHaveBeenCalledWith("client-request");
    expectFailure("prepare", "deadline-observed");
  });

  it("preserves the rejection when diagnostic error inspection throws", async () => {
    const original = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("diagnostic inspection failed");
        },
      },
    );
    shared.acquire.mockRejectedValue(original);
    const result = await listRequest({ controlObservation }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(Object.is(result, original)).toBe(true);
    expect(controlObservation.failed).not.toHaveBeenCalled();
  });

  it("keeps observer exceptions separate from request and cleanup outcomes", async () => {
    const error = new Error("original-request-error");
    const request = vi.fn().mockResolvedValueOnce({ data: [] }).mockRejectedValueOnce(error);
    const throwObserverError = () => {
      throw new Error("observer");
    };
    const throwingObservation = { phase: throwObserverError, failed: throwObserverError };
    shared.acquire.mockResolvedValue({ request });
    await expect(listRequest({ controlObservation: throwingObservation })).resolves.toEqual({
      data: [],
    });
    await expect(listRequest({ controlObservation: throwingObservation })).rejects.toBe(error);
    expect(shared.release).toHaveBeenCalledTimes(2);
  });

  it("keeps a scoped request live when wall time jumps during acquisition", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const request = vi.fn(async () => ({ ok: true }));
    const { entered, acquisition } = deferAcquisition<{ request: typeof request }>(false);
    const result = requestCodexAppServerJson({ method: "model/list", timeoutMs: 1_000 });
    const accepted = expect(result).resolves.toEqual({ ok: true });
    try {
      await entered.promise;
      vi.setSystemTime(Date.now() + 300_100);
      acquisition.resolve({ request });
      await accepted;
      expect(shared.release).toHaveBeenCalledOnce();
    } finally {
      acquisition.resolve({ request });
    }
  });

  it.each([
    { requestTimeoutMs: 10, acquisitionDelayMs: 101, expired: true },
    { requestTimeoutMs: 120_000, acquisitionDelayMs: 700_000, expired: false },
  ])(
    "honors the configured $requestTimeoutMs ms startup budget through control requests",
    async ({ requestTimeoutMs, acquisitionDelayMs, expired }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const harness = createClientHarness();
      const { entered, acquisition } = deferAcquisition<typeof harness.client>();
      const pending = codexControlRequest(
        { appServer: { requestTimeoutMs, transport: "unix", url: "unix://" } },
        "thread/list",
        { limit: 10 },
        {
          timeoutMs: 50,
          startOptions: {
            transport: "unix",
            homeScope: "user",
            command: "codex",
            args: [],
            headers: {},
            url: "unix://",
          },
        },
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      try {
        await Promise.race([entered.promise, pending]);
        expect(shared.acquire).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(acquisitionDelayMs);
        acquisition.resolve(harness.client);
        await vi.advanceTimersByTimeAsync(0);
        if (expired) {
          expect(harness.writes).toEqual([]);
          expect((await pending).error).toMatchObject({ name: "AgentHarnessPreflightError" });
        } else {
          expect(harness.writes).toHaveLength(1);
          const request = JSON.parse(harness.writes[0]!);
          expect(request.method).toBe("thread/list");
          harness.send({ id: request.id, result: { data: [] } });
          expect(await pending).toEqual({ value: { data: [] }, error: undefined });
        }
        expect(shared.release).toHaveBeenCalledOnce();
      } finally {
        acquisition.resolve(harness.client);
        harness.client.close();
        await pending;
      }
    },
  );

  it("does not resume or publish a control attachment after its passive preflight times out", async () => {
    const authority = {
      config: {},
      agentId: "main",
      sessionKey: "agent:main:preflight",
      sessionId: "preflight-session",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await upsertSessionEntry({
      ...authority,
      entry: { sessionId: authority.sessionId, updatedAt: Date.now() },
    });
    vi.useFakeTimers();
    const preflight = createDeferred<void>();
    const request = vi.fn(async (_method: string) => ({ thread: { id: "thread-1" } }));
    shared.acquire.mockResolvedValue({ request });
    const onResponse = vi.fn();

    try {
      const entered = createDeferred<void>();
      const result = codexControlRequest(
        {},
        "thread/resume",
        { threadId: "thread-1" },
        {
          ...authority,
          authProfileId: null,
          timeoutMs: 50,
          beforeRequest: async (send) => {
            await send({
              method: "thread/read",
              requestParams: { threadId: "thread-1", includeTurns: false },
            });
            entered.resolve();
            await preflight.promise;
          },
          onResponse,
        },
      );
      const rejected = expect(result).rejects.toThrow("timed out");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      preflight.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
      expect(onResponse).not.toHaveBeenCalled();
      expect(shared.release).toHaveBeenCalledOnce();
      expect(shared.retire).not.toHaveBeenCalled();
    } finally {
      preflight.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      clearSessionStoreCacheForTest();
    }
  });

  it("revokes scoped requests and mutation authority when their client lease ends", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    shared.acquire.mockResolvedValue({ request });
    const retained = await withCodexAppServerJsonClient({}, async (send, _client, scope) => {
      await send({ method: "thread/read", requestParams: { threadId: "thread-1" } });
      return { send, assertCurrent: scope.assertCurrent };
    });

    expect(retained.assertCurrent).toThrow();
    await expect(
      retained.send({ method: "thread/resume", requestParams: { threadId: "thread-1" } }),
    ).rejects.toThrow();
    await expect(listAllCodexAppServerModels({ request: retained.send })).rejects.toThrow(
      "codex app-server request timed out",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("omits cleanup stacks without suppressing abort-listener diagnostics", async () => {
    const stackTraceLimit = Error.stackTraceLimit;
    const reasons: unknown[] = [];
    const listenerErrors: Error[] = [];
    const listenerStackLimits: number[] = [];
    shared.acquire.mockImplementation(async ({ abandonSignal }: { abandonSignal: AbortSignal }) => {
      abandonSignal.addEventListener("abort", () => {
        reasons.push(abandonSignal.reason);
        listenerStackLimits.push(Error.stackTraceLimit);
        listenerErrors.push(new Error("abort listener diagnostic"));
      });
      return { request: async () => ({ data: [] }) };
    });

    try {
      Error.stackTraceLimit = 10;
      for (let i = 0; i < 2; i += 1) {
        await expect(
          requestCodexAppServerJson({ method: "model/list", requestParams: {} }),
        ).resolves.toEqual({ data: [] });
      }
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).not.toBe(reasons[1]);
      for (const reason of reasons) {
        expect(reason).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
        expect(isNativeError(reason)).toBe(true);
        expect(reason).toMatchObject({
          message: "codex app-server model/list timed out",
        });
        if (process.versions.bun) {
          expect(reason).not.toHaveProperty("stack");
        } else {
          expect(reason).toHaveProperty(
            "stack",
            "CodexAppServerScopedRequestRejectedError: codex app-server model/list timed out",
          );
        }
      }
      expect(listenerStackLimits).toEqual([10, 10]);
      for (const error of listenerErrors) {
        expect(error.stack).toContain("\n    at ");
      }
      expect(Error.stackTraceLimit).toBe(10);
    } finally {
      Error.stackTraceLimit = stackTraceLimit;
    }
  });

  it("does not request another model page after the shared deadline", async () => {
    vi.useFakeTimers();
    const page = createDeferred<{ data: never[]; nextCursor: string }>();
    const request = vi.fn(() => page.promise);
    shared.acquire.mockResolvedValue({ request });
    const result = withCodexAppServerJsonClient(
      { timeoutMs: 50, controlObservation },
      async (scopedRequest) => listAllCodexAppServerModels({ request: scopedRequest }),
    );
    const rejection = expect(result).rejects.toThrow("codex app-server request timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    page.resolve({ data: [], nextCursor: "next-page" });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(shared.release).toHaveBeenCalledOnce();
    expectFailure("client-request", "deadline-observed");
  });

  it.each([300_100])(
    "reads usage and account identity across a %i ms wall-clock jump",
    async (wallJumpMs) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const request = vi.fn(async (method: string) => {
        if (method === "account/rateLimits/read") {
          vi.setSystemTime(Date.now() + wallJumpMs);
          return { rateLimitsByLimitId: { codex: { limitId: "codex" } } };
        }
        return {
          account: { type: "chatgpt", email: "codex-account@example.com" },
        };
      });
      const { closeAndWait } = isolatedClient(request);

      await expect(
        readCodexAppServerUsage({
          timeoutMs: 3_500,
          authProfileId: "openai:test",
        }),
      ).resolves.toEqual({
        rateLimits: { rateLimitsByLimitId: { codex: { limitId: "codex" } } },
        accountEmail: "codex-account@example.com",
      });
      expect(shared.isolated.mock.calls[0]?.[0].authProfileId).toBe("openai:test");
      expect(shared.isolated).toHaveBeenCalledOnce();
      expect(closeAndWait).toHaveBeenCalledWith({ exitTimeoutMs: 300, forceKillDelayMs: 200 });
    },
  );

  it("guards isolated usage startup before login when request authority is revoked", async () => {
    const login = vi.fn();
    const assertCurrent = () => {
      throw new Error("Account removed");
    };
    shared.isolated.mockImplementation(async (options) => {
      options.assertCurrent?.();
      login();
      throw new Error("unguarded login");
    });
    await expect(readCodexAppServerUsage({ timeoutMs: 1_000, assertCurrent })).rejects.toThrow(
      "Account removed",
    );
    expect(login).not.toHaveBeenCalled();
  });
});

// Native ESM resolution is outside Vitest's module cache: exercise the request
// owner in a subprocess so repeated import() work remains observable.
it("reuses loaded request modules across warm requests", async ({ signal }) => {
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/codex-request-imports.ts",
      "--mode",
      "counts",
      "--iterations",
      "3",
      "--assert-single-load",
    ],
    { cwd: process.cwd(), signal },
  );
});
