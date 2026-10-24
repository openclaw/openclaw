import path from "node:path";
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

const expectDeadlineOptions = () =>
  expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.anything() });
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
const mockRequest = (response: unknown = { ok: true }) => {
  const request = vi.fn(async () => response);
  shared.acquire.mockResolvedValue({ request });
  return request;
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
    for (const mock of Object.values(shared)) {
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
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: { sessionId: "first-session", updatedAt: 1 },
    });
    const selected = await captureSessionEntryCurrentCheckAsync({
      agentId: "main",
      storePath,
      sessionKey,
    });
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
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: { sessionId: "replacement-session", updatedAt: 2 },
      });
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
    ["app/installed", { threadId: "thread-1", forceRefresh: false }, true],
    ["app/read", { appIds: ["calendar-app"], includeTools: false }, true],
    ["plugin/installed", { cwds: [] }, true],
    ["experimentalFeature/list", {}, true],
    [
      "config/batchWrite",
      {
        edits: [
          {
            keyPath: 'apps."calendar".tools."create".approval_mode',
            value: null,
            mergeStrategy: "replace",
          },
        ],
      },
      true,
    ],
    ["thread/name/set", { threadId: "thread-1", name: "Shared thread" }, false],
    ["thread/archive", { threadId: "thread-1" }, false],
    ["thread/unarchive", { threadId: "thread-1" }, false],
    [
      "config/value/write",
      {
        keyPath: 'apps."google-calendar-app".tools',
        value: null,
        mergeStrategy: "replace",
      },
      false,
    ],
    ["config/read", { includeLayers: false }, false],
    ["thread/start", sandboxEnvironment, false],
  ] as const)("allows %s under its execution policies", async (method, requestParams, alsoNode) => {
    const response = { ok: true };
    const request = mockRequest(response);
    const policies = alsoNode ? [sandboxPolicy, nodePolicy] : [sandboxPolicy];
    for (const policy of policies) {
      await expect(
        requestCodexAppServerJson({ method, requestParams, ...policy }),
      ).resolves.toEqual(response);
    }
    expect(request).toHaveBeenCalledTimes(policies.length);
    for (let index = 0; index < policies.length; index++) {
      expect(request).toHaveBeenNthCalledWith(
        index + 1,
        method,
        requestParams,
        expectDeadlineOptions(),
      );
    }
  });

  it.each([
    {
      error: new CodexAppServerRpcError({ code: -32601, message: "private-rpc" }, "thread/list"),
      category: "rpc-method-unavailable",
    },
    {
      error: new CodexAppServerRpcError({ code: -32603, message: "private-rpc" }, "thread/list"),
      category: "rpc-error",
    },
    { error: new Error("private-error-with-no-typed-contract"), category: "other" },
  ])(
    "reports control observation category $category without replacing the error",
    async ({ error, category }) => {
      const request = vi.fn().mockRejectedValue(error);
      const controlObservation = { phase: vi.fn(), failed: vi.fn() };
      shared.acquire.mockResolvedValue({ request });
      await expect(listRequest({ requestParams: { limit: 1 }, controlObservation })).rejects.toBe(
        error,
      );
      expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
        phase: "client-request",
        category,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/list",
        { limit: 1 },
        expectDeadlineOptions(),
      );
      expect(request.mock.calls[0]?.[2]).not.toHaveProperty("controlObservation");
      expect(shared.acquire.mock.calls[0]?.[0]).not.toHaveProperty("controlObservation");
      expect(shared.release).toHaveBeenCalledOnce();
      expect(JSON.stringify(controlObservation.failed.mock.calls)).not.toContain("private-");
    },
  );

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
      const request = vi.spyOn(harness.client, "request");
      const attemptWaiterFinished = vi.fn();
      const controlObservation = { phase: vi.fn(), failed: vi.fn(), attemptWaiterFinished };
      shared.acquire.mockResolvedValue(harness.client);
      try {
        const params = { method, requestParams: {}, controlObservation };
        const result =
          owner === "owned"
            ? requestCodexAppServerClientJson({ ...params, client: harness.client })
            : requestCodexAppServerJson(params);
        await expect(result).resolves.toEqual({ data: [] });
        const options = request.mock.calls[0]?.[2];
        expect(options).not.toHaveProperty("controlObservation");
        if (method === "thread/list") {
          expect(options?.attemptWaiterFinished).toBe(attemptWaiterFinished);
          expect(attemptWaiterFinished).toHaveBeenCalledOnce();
        } else {
          expect(options).not.toHaveProperty("attemptWaiterFinished");
          expect(attemptWaiterFinished).not.toHaveBeenCalled();
        }
        if (owner === "owned") {
          expect(shared.acquire).not.toHaveBeenCalled();
        } else {
          const acquisition = shared.acquire.mock.calls[0]?.[0];
          expect(acquisition).not.toHaveProperty("controlObservation");
          expect(acquisition).not.toHaveProperty("attemptWaiterFinished");
        }
      } finally {
        harness.client.close();
        harness.emitExit();
      }
    },
  );

  it("reports an acquisition rejection without inventing a client request or lease", async () => {
    const error = new Error("private-acquire-error");
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    shared.acquire.mockRejectedValue(error);
    await expect(listRequest({ controlObservation })).rejects.toBe(error);
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "acquire-client",
      category: "other",
    });
    expect(controlObservation.phase).not.toHaveBeenCalledWith("client-request");
    expect(shared.release).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records the actual escaping error when cleanup fails: $0",
    async (cleanupFails) => {
      const requestError = new Error("private-request-error");
      const cleanupError = new Error("private-cleanup-error");
      const controlObservation = { phase: vi.fn(), failed: vi.fn() };
      shared.isolated.mockResolvedValue({
        request: vi.fn().mockRejectedValue(requestError),
        closeAndWait: vi.fn(async () => {
          if (cleanupFails) {
            throw cleanupError;
          }
        }),
      });
      await expect(listRequest({ isolated: true, controlObservation })).rejects.toBe(
        cleanupFails ? cleanupError : requestError,
      );
      expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
        phase: cleanupFails ? "release-client" : "client-request",
        category: "other",
      });
    },
  );

  it("records the later deadline decision when successful cleanup crosses the deadline", async () => {
    vi.useFakeTimers();
    const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const requestError = new Error("private-request-error");
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    shared.isolated.mockResolvedValue({
      request: vi.fn().mockRejectedValue(requestError),
      closeAndWait: vi.fn(async () => {
        elapsedClock.mockReturnValue(51);
      }),
    });
    await expect(
      listRequest({ timeoutMs: 50, isolated: true, controlObservation }),
    ).rejects.toMatchObject({
      message: "codex app-server thread/list timed out",
      cause: requestError,
    });
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "release-client",
      category: "deadline-observed",
    });
  });

  it("does not claim API entry when argument evaluation expires the budget before the later deadline decision", async () => {
    vi.useFakeTimers();
    const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const request = vi.fn();
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    shared.acquire.mockResolvedValue({ request });
    await expect(
      withCodexAppServerJsonClient(
        {
          timeoutMs: 50,
          controlObservation,
        },
        async (send) => {
          return await send({
            method: "thread/list",
            get requestParams() {
              elapsedClock.mockReturnValue(51);
              return {};
            },
          });
        },
      ),
    ).rejects.toThrow("codex app-server request timed out");
    expect(request).not.toHaveBeenCalled();
    expect(controlObservation.phase).not.toHaveBeenCalledWith("client-request");
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "prepare",
      category: "deadline-observed",
    });
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
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
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
    const controlObservation = {
      phase: () => {
        throw new Error("observer");
      },
      failed: () => {
        throw new Error("observer");
      },
    };
    shared.acquire.mockResolvedValue({ request });
    await expect(listRequest({ controlObservation })).resolves.toEqual({ data: [] });
    await expect(listRequest({ controlObservation })).rejects.toBe(error);
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
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "model/list",
        undefined,
        expectDeadlineOptions(),
      );
      expect(shared.release).toHaveBeenCalledOnce();
    } finally {
      acquisition.resolve({ request });
    }
  });

  it("abandons a pending acquisition without issuing a request after the startup deadline", async () => {
    vi.useFakeTimers();
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    const request = vi.fn(async () => ({ ok: true }));
    type TestClient = { request: typeof request };
    const client: TestClient = { request };
    const { acquisition, entered: acquisitionStarted } = deferAcquisition<TestClient>();

    const result = listRequest({
      requestParams: { limit: 10 },
      timeoutMs: 50,
      pluginConfig: { appServer: { requestTimeoutMs: 10 } },
      controlObservation,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      userMessage:
        "Codex app-server startup exceeded its wait budget. Retry this request; if it persists, check the Gateway logs.",
    });
    await acquisitionStarted.promise;
    const acquireOptions = shared.acquire.mock.calls[0]?.[0] as
      | { abandonSignal?: AbortSignal; timeoutMs?: number }
      | undefined;

    expect(acquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(acquireOptions?.timeoutMs).toBeLessThanOrEqual(100);
    await vi.advanceTimersByTimeAsync(150);
    await rejection;
    expect(acquireOptions?.abandonSignal?.aborted).toBe(true);
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "acquire-client",
      category: "deadline-observed",
    });

    acquisition.resolve(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
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
    const root = sessionDirs.make();
    const authority = {
      config: {},
      agentId: "main",
      sessionKey: "agent:main:preflight",
      sessionId: "preflight-session",
      storePath: path.join(root, "sessions.json"),
    };
    await upsertSessionEntry({
      ...authority,
      entry: { sessionId: authority.sessionId, updatedAt: Date.now() },
    });
    vi.useFakeTimers();
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
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
            await preflight;
          },
          onResponse,
        },
      );
      const settled = result.then(
        (value) => ({ status: "fulfilled", value }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      expect(await settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: expect.stringContaining("timed out") }),
      });
      releasePreflight();
      await vi.advanceTimersByTimeAsync(0);

      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
      expect(onResponse).not.toHaveBeenCalled();
      expect(shared.release).toHaveBeenCalledOnce();
      expect(shared.retire).not.toHaveBeenCalled();
    } finally {
      releasePreflight();
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
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
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
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "client-request",
      category: "deadline-observed",
    });
  });

  it("shares one guarded isolated client across installed-plugin and account reads", async () => {
    const installed = { marketplaces: [], marketplaceLoadErrors: [] };
    const account = { account: { email: "codex-source@example.com" } };
    const request = vi.fn(async (method: string) =>
      method === "plugin/installed" ? installed : account,
    );
    const closeAndWait = vi.fn(async () => undefined);
    shared.isolated.mockResolvedValue({
      request,
      closeAndWait,
    });
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
      env: { CODEX_HOME: "/source/.codex", HOME: "/source" },
    };

    await expect(
      withCodexAppServerJsonClient(
        { timeoutMs: 5_000, startOptions, authProfileId: null, isolated: true },
        async (scopedRequest) => ({
          installed: await scopedRequest<typeof installed>({
            method: "plugin/installed",
            requestParams: { cwds: [] },
          }),
          account: await scopedRequest<typeof account>({
            method: "account/read",
            requestParams: { refreshToken: false },
          }),
        }),
      ),
    ).resolves.toEqual({ installed, account });

    expect(shared.isolated).toHaveBeenCalledTimes(1);
    expect(shared.isolated).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions, authProfileId: null }),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "plugin/installed",
      { cwds: [] },
      expectDeadlineOptions(),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "account/read",
      { refreshToken: false },
      expectDeadlineOptions(),
    );
    expect(closeAndWait).toHaveBeenCalledExactlyOnceWith({
      exitTimeoutMs: 2_000,
      forceKillDelayMs: 250,
    });
  });

  it.each([0, 300_100])(
    "reads usage and account identity across a %i ms wall-clock jump",
    async (wallJumpMs) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const request = vi.fn(async (method: string) => {
        if (method === "account/rateLimits/read") {
          vi.setSystemTime(Date.now() + wallJumpMs);
          return { rateLimitsByLimitId: { codex: { limitId: "codex" } } };
        }
        return {
          account: { type: "chatgpt", email: "codex-account@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        };
      });
      const closeAndWait = vi.fn(async () => undefined);
      shared.isolated.mockResolvedValue({
        request,
        closeAndWait,
      });

      await expect(
        readCodexAppServerUsage({
          timeoutMs: 3_500,
          authProfileId: "openai:test",
        }),
      ).resolves.toEqual({
        rateLimits: { rateLimitsByLimitId: { codex: { limitId: "codex" } } },
        accountEmail: "codex-account@example.com",
      });
      expect(shared.isolated).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: "openai:test",
          timeoutMs: expect.any(Number),
        }),
      );
      expect(request).toHaveBeenNthCalledWith(
        1,
        "account/rateLimits/read",
        undefined,
        expectDeadlineOptions(),
      );
      expect(request).toHaveBeenNthCalledWith(2, "account/read", {}, expectDeadlineOptions());
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
