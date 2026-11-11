import type { CopilotClient, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import {
  attachModelProviderRequestTransport,
  type AgentHarness,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotSessionBinding } from "./harness.js";
import {
  asAttemptParams,
  asCompleteAttemptResult,
  asFinalizationAttempt,
  createCopilotAgentHarness,
  makeSessionStoreMock,
} from "./harness.test-support.js";
import { resolvePoolAcquire } from "./src/attempt-config.js";
import type { CopilotAttemptDeps } from "./src/attempt-types.js";
import { tokenFingerprint } from "./src/auth-bridge.js";
import { createCopilotIsolatedCompletionParams } from "./src/isolated-completion.test-support.js";
import type { CopilotClientPool, PoolKey } from "./src/runtime.js";

type IsolatedParams = Parameters<NonNullable<AgentHarness["runIsolatedCompletionV2"]>>[0];
type Store = ReturnType<typeof makeSessionStoreMock>;
const mocks = vi.hoisted(() => ({
  attempt: vi.fn(),
  acquire: vi.fn<typeof resolvePoolAcquire>(),
  proxy: vi.fn(),
  pool: vi.fn(),
}));
// mock-isolation: Harness lifecycle tests must not execute a real Copilot attempt.
vi.mock("./src/attempt.js", () => ({
  runCopilotAttempt: mocks.attempt,
  resolvePoolAcquire: mocks.acquire,
}));
// mock-isolation: Supply a synthetic proxy without starting a network listener.
vi.mock("./src/byok-proxy.js", () => ({ createCopilotByokProxy: mocks.proxy }));
// mock-isolation: Keep client acquisition and disposal in the fixture-owned pool.
vi.mock("./src/runtime.js", () => ({ createCopilotClientPool: mocks.pool }));

const RESULT = asCompleteAttemptResult({ ok: true });
const KEY = {
  agentId: "test",
  authMode: "useLoggedInUser",
  copilotHome: "/tmp/copilot",
} satisfies PoolKey;
const CONFIG = { availableTools: [], model: "gpt-4.1", tools: [], workingDirectory: "/workspace" };
const ISOLATED = createCopilotIsolatedCompletionParams({ thinkLevel: "high" });
const MODEL = {
  provider: "custom-proxy",
  id: "proxy-model",
  api: "openai-responses",
  baseUrl: "https://proxy.example/v1",
};

function client(overrides: Record<string, unknown> = {}): CopilotClient {
  return overrides as unknown as CopilotClient;
}
function params(overrides: Record<string, unknown> = {}): any {
  return {
    provider: "github-copilot",
    model: "gpt-4.1",
    cwd: "/ws",
    workspaceDir: "/ws",
    agentDir: "/home",
    copilotHome: "/copilot-home",
    auth: { useLoggedInUser: true },
    sessionId: "oc",
    ...overrides,
  };
}
function poolMock() {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  } satisfies CopilotClientPool;
}
function fixture(store?: Store, owned = false, overrides: Record<string, unknown> = {}) {
  const pool = poolMock();
  if (owned) {
    mocks.pool.mockReturnValue(pool);
  }
  const harness = createCopilotAgentHarness({
    ...(owned ? {} : { pool }),
    ...(store ? { sessionStore: store.store } : {}),
  });
  const input = params(overrides);
  return {
    pool,
    harness,
    run: (extra = {}) => harness.runAttempt({ ...input, ...extra }),
    compact: (extra = {}) =>
      harness.compact?.({ ...input, sessionFile: "/session.json", ...extra }),
    reset: (sessionId = input.sessionId) => harness.reset?.({ sessionId }),
  };
}
function publication(sdkSessionId: string, sdkClient = client(), sessionConfig = CONFIG) {
  return { sdkSessionId, pooledClient: { key: KEY, client: sdkClient }, sessionConfig };
}
function nextSession(
  sdkSessionId: string,
  options: {
    client?: CopilotClient;
    config?: SessionConfig;
    after?: (deps: CopilotAttemptDeps) => void | Promise<void>;
    result?: typeof RESULT & { sdkSessionId?: string; journalValidated?: boolean };
  } = {},
) {
  mocks.attempt.mockImplementationOnce(async (_input, deps: CopilotAttemptDeps) => {
    await deps.onSessionEstablished?.({
      ...publication(sdkSessionId, options.client),
      ...(options.config ? { compactionSessionConfig: options.config } : {}),
    });
    if (options.after) {
      await options.after(deps);
    }
    return options.result ?? RESULT;
  });
}
function replay(index: number) {
  const input = mocks.attempt.mock.calls[index]?.[0];
  expect(input).toBeDefined();
  return input.initialReplayState;
}
function background(sdkSessionId: string) {
  const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
  return { cleanup, event: { sdkSessionId, cleanup: cleanup.promise, abort: vi.fn() } };
}
const failed = (reason: string, rawError?: string) => ({
  ok: false,
  compacted: false,
  reason,
  failure: { reason, ...(rawError === undefined ? {} : { rawError }) },
});
async function flush() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
function isolated(
  data: Extract<SessionEvent, { type: "assistant.message" }>["data"] = {
    content: "",
    messageId: "message-1",
  },
) {
  const session = {
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue({ type: "assistant.message", data }),
  };
  const createSession = vi.fn().mockResolvedValue(session);
  const resumeSession = vi.fn();
  const handle = { key: KEY, client: client({ createSession, resumeSession }) };
  const pool = poolMock();
  pool.acquire.mockResolvedValue(handle);
  const harness = createCopilotAgentHarness({ pool });
  return {
    session,
    pool,
    handle,
    harness,
    createSession,
    resumeSession,
    complete: (extra: Partial<IsolatedParams> = {}) =>
      harness.runIsolatedCompletionV2?.({ ...ISOLATED, ...extra }),
  };
}
function compaction(
  result = { success: true, tokensRemoved: 45, messagesRemoved: 2 },
  store?: Store,
  input: Record<string, unknown> = {},
) {
  const f = fixture(store, false, input);
  const compact = vi.fn(async () => structuredClone(result));
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const session = { disconnect, rpc: { history: { compact } } };
  const resumeSession = vi.fn(async () => session);
  const sdkClient = client({ deleteSession: vi.fn(), resumeSession });
  f.pool.acquire.mockResolvedValue({ key: KEY, client: sdkClient });
  f.pool.release.mockResolvedValue(undefined);
  return {
    ...f,
    compactRpc: compact,
    disconnect,
    session,
    resumeSession,
    establish: (id = "sdk", extra: Parameters<typeof nextSession>[1] = {}) =>
      nextSession(id, { client: sdkClient, ...extra }),
  };
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Copilot harness", () => {
  beforeEach(() => {
    mocks.attempt.mockReset().mockResolvedValue(RESULT);
    mocks.acquire.mockReset().mockImplementation(resolvePoolAcquire);
    mocks.proxy.mockReset().mockResolvedValue(undefined);
    mocks.pool.mockReset().mockImplementation(poolMock);
  });
  afterEach(resetGlobalHookRunner);

  it.each([
    [{ provider: "github-copilot", requestedRuntime: "auto" }, false],
    [{}, false],
    [
      {
        modelProvider: {
          ...MODEL,
          request: { proxy: { mode: "env-proxy" } },
        },
      },
      false,
    ],
    [{ provider: "  GitHub-Copilot  ", requestedRuntime: "  COPILOT  " }, true],
    [{ modelProvider: MODEL }, true],
  ] satisfies Array<[Partial<Parameters<AgentHarness["supports"]>[0]>, boolean]>)(
    "selects only supported opt-in models (%j)",
    (extra, supported) => {
      const { harness } = fixture();
      const selection = harness.supports({
        provider: "custom-proxy",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
        providerOwnerStatus: "unowned",
        providerOwnerPluginIds: [],
        ...extra,
      });
      expect(selection).toMatchObject({ supported, ...(supported ? { priority: 100 } : {}) });
    },
  );

  it("keeps invalid BYOK configuration on the structured attempt path", async () => {
    const f = fixture(undefined, true);
    mocks.acquire.mockImplementationOnce(() => {
      throw new Error(
        "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl",
      );
    });
    await expect(f.run()).resolves.toBe(RESULT);
  });

  it("finalizes only the compatible session without replaying side effects", async () => {
    const f = fixture();
    const input = asAttemptParams(params({ initialReplayState: { replayInvalid: true } }));
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "final answer" }],
      stopReason: "stop" as const,
    };
    nextSession("sdk");
    mocks.attempt.mockResolvedValueOnce(
      asCompleteAttemptResult({
        assistantTexts: ["final answer"],
        currentAttemptCompletedAssistant: assistant,
      }),
    );
    await f.harness.runAttempt(input);
    await expect(
      f.harness.finalizeSettledTurn?.({
        attempt: asFinalizationAttempt(input),
        settledAttempt: RESULT,
      }),
    ).resolves.toMatchObject({ assistant });
    expect(replay(1)).toEqual({ sdkSessionId: "sdk" });
    expect(mocks.attempt.mock.calls[1]?.[0]?.sessionId).toBe("oc");
    expect(mocks.attempt.mock.calls[1]?.[1]).toMatchObject({
      operation: "settled-tool-finalization",
      onSessionEstablished: undefined,
    });
  });

  it("fails closed when finalization has no compatible session", async () => {
    const f = fixture();
    await expect(
      f.harness.finalizeSettledTurn?.({
        attempt: asFinalizationAttempt(asAttemptParams(params())),
        settledAttempt: RESULT,
      }),
    ).rejects.toThrow(
      "cannot safely finalize a settled tool turn without its compatible SDK session",
    );
    expect(mocks.attempt).not.toHaveBeenCalled();
  });

  it("uses a fresh, capability-free isolated native session", async () => {
    const f = isolated({ content: "Four.", messageId: "message-1" });
    const reply = await f.complete({ streamParams: { maxTokens: 800, temperature: 0.2 } });
    expect(reply?.assistant.content).toEqual([{ type: "text", text: "Four." }]);
    expect(reply?.assistant.stopReason).toBe("stop");
    expect(f.pool.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "gitHubToken",
        authProfileId: "github:work",
        authProfileVersion: "prepared-owner-fingerprint",
        clientMode: "empty",
      }),
      expect.objectContaining({
        gitHubToken: "prepared-github-token",
        mode: "empty",
        useLoggedInUser: false,
      }),
    );
    expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.resumeSession).not.toHaveBeenCalled();
    expect(f.createSession.mock.calls[0]?.[0]).toMatchObject({
      availableTools: [],
      coauthorEnabled: false,
      customAgents: [],
      enableConfigDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableOnDemandInstructionDiscovery: false,
      enableSessionStore: false,
      enableSkills: false,
      excludedTools: ["builtin:*", "mcp:*", "custom:*"],
      includeSubAgentStreamingEvents: false,
      manageScheduleEnabled: false,
      mcpServers: {},
      memory: { enabled: false },
      model: "gpt-4.1",
      pluginDirectories: [],
      requestCanvasRenderer: false,
      requestExtensions: false,
      skillDirectories: [],
      skipCustomInstructions: true,
      skipEmbeddingRetrieval: true,
      tools: [],
      systemMessage: { mode: "replace", content: "Answer only from the supplied prompt." },
    });
    for (const key of [
      "hooks",
      "maxTokens",
      "onEvent",
      "onPermissionRequest",
      "onUserInputRequest",
      "temperature",
    ]) {
      expect(f.createSession.mock.calls[0]?.[0]).not.toHaveProperty(key);
    }
    expect(f.session.sendAndWait).toHaveBeenCalledWith(
      { prompt: ISOLATED.prompt },
      expect.any(Number),
    );
    const budget = f.session.sendAndWait.mock.calls[0]?.[1];
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(30_000);
    expect(f.session.disconnect).toHaveBeenCalledOnce();
    expect(f.pool.release).toHaveBeenCalledWith(f.handle);
  });

  it.each([
    {
      reason: "requires host-prepared authorization",
      extra: {
        authorization: {
          owner: "harness",
          plan: { providerForAuth: "github-copilot", authProfileProviderForAuth: "github-copilot" },
          authProfileStore: { version: 1, profiles: {} },
        },
      },
    },
    { reason: "does not support thinking level off", extra: { thinkLevel: "off" } },
  ] satisfies Array<{ reason: string; extra: Partial<IsolatedParams> }>)(
    "rejects $reason before acquisition",
    async ({ reason, extra }) => {
      const f = isolated();
      await expect(f.complete(extra)).rejects.toThrow(reason);
      expect(f.pool.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(["client acquisition", "session creation"] as const)(
    "rechecks authority after %s and cleans rejected resources",
    async (stage) => {
      const f = isolated({ content: "Must not be returned", messageId: "revoked-owner" });
      const controller = new AbortController();
      const retired = new Error("isolated completion owner retired");
      let current = true;
      const sessionReady = createDeferred<typeof f.session>();
      const handleReady = createDeferred<typeof f.handle>();
      f.createSession.mockReturnValue(
        stage === "session creation" ? sessionReady.promise : Promise.resolve(f.session),
      );
      f.pool.acquire.mockReturnValue(
        stage === "client acquisition" ? handleReady.promise : Promise.resolve(f.handle),
      );
      f.pool.release.mockResolvedValue(undefined);
      const pending = f.complete({
        abortSignal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw retired;
          }
        },
      });
      try {
        await vi.waitFor(() =>
          expect(
            stage === "client acquisition" ? f.pool.acquire : f.createSession,
          ).toHaveBeenCalledOnce(),
        );
        current = false;
      } finally {
        handleReady.resolve(f.handle);
        sessionReady.resolve(f.session);
      }
      await expect(pending).rejects.toBe(retired);
      await flush();
      expect(controller.signal.aborted).toBe(false);
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
      expect(f.pool.release).toHaveBeenCalledExactlyOnceWith(f.handle);
      if (stage === "client acquisition") {
        expect(f.createSession).not.toHaveBeenCalled();
      } else {
        expect(f.session.abort).toHaveBeenCalledOnce();
        expect(f.session.disconnect).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not send when cancellation wins the send boundary", async () => {
    const controller = new AbortController();
    let registrations = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      add(...args);
      if (++registrations === 5) {
        queueMicrotask(() => controller.abort(new Error("cancelled at send boundary")));
      }
    });
    const f = isolated();
    f.session.sendAndWait.mockReset();
    await expect(f.complete({ abortSignal: controller.signal })).rejects.toThrow(
      "cancelled at send boundary",
    );
    await flush();
    expect(registrations).toBe(5);
    expect(f.session.sendAndWait).not.toHaveBeenCalled();
    expect(f.session.abort).toHaveBeenCalledOnce();
    expect(f.session.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects a late session after its deadline even when abort wedges", async () => {
    const f = isolated();
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const disconnected = createDeferred<void>();
    const ready = createDeferred<typeof f.session>();
    f.session.abort.mockReturnValue(new Promise<void>(() => {}));
    f.session.disconnect.mockImplementation(async () => disconnected.resolve());
    f.session.sendAndWait.mockReset();
    f.createSession.mockImplementation(() => {
      started.resolve();
      return ready.promise;
    });
    f.pool.release.mockImplementation(async () => released.resolve());
    vi.useFakeTimers();
    try {
      const rejected = expect(f.complete({ timeoutMs: 5 })).rejects.toThrow("timed out after 5ms");
      await started.promise;
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      ready.resolve(f.session);
      await released.promise;
      await disconnected.promise;
      expect(f.session.abort).toHaveBeenCalledOnce();
      expect(f.session.disconnect).toHaveBeenCalledOnce();
      expect(f.pool.release).toHaveBeenCalledExactlyOnceWith(f.handle);
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
    } finally {
      ready.resolve(f.session);
      vi.useRealTimers();
    }
  });

  it("uses the prepared BYOK model, credential, headers and output limit", async () => {
    const f = isolated({ content: "Done.", messageId: "message-1" });
    const input = {
      ...ISOLATED,
      provider: "custom-openai",
      modelId: "prepared-model",
      authorization: {
        ...ISOLATED.authorization,
        model: {
          ...ISOLATED.authorization.model,
          id: "prepared-model",
          name: "Prepared model",
          provider: "custom-openai",
          baseUrl: "https://inference.example/v1",
          headers: { "x-tenant": "tenant-a" },
        },
        auth: {
          apiKey: "prepared-byok-key",
          profileId: "custom:work",
          source: "profile",
          mode: "api-key",
        },
      },
      streamParams: { maxTokens: 321 },
    } satisfies IsolatedParams;
    await expect(f.complete(input)).resolves.toHaveProperty("assistant.content", [
      { type: "text", text: "Done." },
    ]);
    expect(f.createSession.mock.calls[0]?.[0]).toMatchObject({
      model: "prepared-model",
      provider: {
        apiKey: "prepared-byok-key",
        baseUrl: "https://inference.example/v1",
        headers: { "x-tenant": "tenant-a" },
        maxOutputTokens: 321,
      },
    });
    expect(f.session.sendAndWait).toHaveBeenCalledWith(
      { prompt: input.prompt, requestHeaders: { "x-tenant": "tenant-a" } },
      expect.any(Number),
    );
    expect(f.session.sendAndWait.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(f.session.sendAndWait.mock.calls[0]?.[1]).toBeLessThanOrEqual(input.timeoutMs);
  });

  it("disposal before startup prevents pool creation", async () => {
    const f = fixture(undefined, true);
    await f.harness.dispose?.();
    await expect(f.run()).rejects.toThrow("harness has been disposed; cannot start new attempts");
    await expect(f.harness.dispose?.()).resolves.toBeUndefined();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.attempt).not.toHaveBeenCalled();
  });

  it("finishes admitted lazy startup before disposing the owned pool", async () => {
    const f = fixture(undefined, true);
    const started = createDeferred<void>(),
      finish = createDeferred<void>();
    mocks.attempt.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return RESULT;
    });
    const attempt = f.run(),
      disposal = f.harness.dispose?.();
    const settled = Promise.allSettled([attempt, disposal]);
    try {
      await Promise.race([started.promise, attempt]);
      expect(f.pool.dispose).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await settled;
    }
    await expect(attempt).resolves.toBe(RESULT);
    await expect(disposal).resolves.toBeUndefined();
    expect(f.pool.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces all pool disposal errors", async () => {
    const f = fixture(undefined, true);
    const errors = [new Error("first"), new Error("second")];
    f.pool.dispose.mockResolvedValue(errors);
    await f.run();
    const disposal = f.harness.dispose?.();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(disposal).rejects.toMatchObject({
      message: "[copilot] pool disposal errors",
      errors,
    });
  });

  it("does not delete a different OpenClaw session", async () => {
    const f = fixture(),
      remove = vi.fn().mockResolvedValue(undefined);
    nextSession("sdk", { client: client({ deleteSession: remove }) });
    await f.run();
    await f.reset("other");
    expect(remove).not.toHaveBeenCalled();
  });

  it("joins deferred binding deletion before pool disposal", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store, true);
    const deletion = createDeferred<void>(),
      admitted = createDeferred<void>();
    store.store.delete.mockImplementationOnce(async (key) => {
      admitted.resolve();
      await deletion.promise;
      return store.entries.delete(key);
    });
    const bg = background("sdk");
    bg.event.abort.mockImplementation(() => bg.cleanup.resolve("aborted"));
    nextSession("sdk", { after: (deps) => deps.onDeferredCompaction?.(bg.event) });
    await f.run();
    const disposal = f.harness.dispose?.(),
      repeated = f.harness.dispose?.();
    await admitted.promise;
    await flush();
    expect(f.pool.dispose).not.toHaveBeenCalled();
    deletion.resolve();
    await Promise.all([disposal, repeated]);
    expect(store.entries.has("oc")).toBe(false);
    expect(f.pool.dispose).toHaveBeenCalledOnce();
  });

  it("blocks reuse during reset without deleting the replacement", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store);
    const bg = background("before");
    const removeReplacement = vi.fn().mockResolvedValue(undefined);
    const removeDuringReset = vi.fn().mockResolvedValue(undefined);
    nextSession("before", { after: (deps) => deps.onDeferredCompaction?.(bg.event) });
    nextSession("replacement", { client: client({ deleteSession: removeReplacement }) });
    mocks.attempt.mockImplementationOnce(async (input, deps) => {
      if (!input.initialReplayState?.sdkSessionId) {
        await deps.onSessionEstablished?.(
          publication("during", client({ deleteSession: removeDuringReset })),
        );
      }
      return RESULT;
    });
    await f.run();
    await f.run();
    const reset = f.reset();
    await vi.waitFor(() => expect(bg.event.abort).toHaveBeenCalledOnce());
    await f.run();
    bg.cleanup.resolve("aborted");
    await reset;
    expect(replay(2)?.sdkSessionId).toBeUndefined();
    expect(removeReplacement).toHaveBeenCalledWith("replacement");
    expect(removeDuringReset).not.toHaveBeenCalled();
    expect(store.entries.get("oc")?.sdkSessionId).toBe("during");
  });

  it("blocks reuse during background compaction and resumes after completion", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store),
      bg = background("sdk");
    nextSession("sdk", { after: (deps) => deps.onDeferredCompaction?.(bg.event) });
    await f.run();
    await f.run();
    expect(replay(1)?.sdkSessionId).toBeUndefined();
    await expect(f.compact()).resolves.toEqual(failed("background-compaction-pending"));
    expect(f.pool.acquire).not.toHaveBeenCalled();
    bg.cleanup.resolve("completed");
    await flush();
    await f.run();
    expect(replay(2)?.sdkSessionId).toBe("sdk");
    expect(store.store.delete).not.toHaveBeenCalledWith("oc");
  });

  it("ignores stale cleanup published by an overlapping attempt", async () => {
    const f = fixture(),
      finish = createDeferred<void>(),
      bg = background("stale");
    let firstDeps: CopilotAttemptDeps | undefined;
    nextSession("stale", {
      after: async (deps) => {
        firstDeps = deps;
        await finish.promise;
      },
    });
    nextSession("current");
    const first = f.run();
    await flush();
    await f.run();
    void firstDeps?.onDeferredCompaction?.(bg.event);
    finish.resolve();
    await first;
    await f.run();
    expect(replay(2)?.sdkSessionId).toBe("current");
    bg.cleanup.resolve("completed");
    await flush();
  });

  it.each([
    {
      name: "auth profile",
      before: { auth: undefined, authProfileId: "p1", resolvedApiKey: "token" },
      after: { auth: undefined, authProfileId: "p2", resolvedApiKey: "token" },
      restart: false,
    },
    {
      name: "token fingerprint",
      before: { auth: undefined, authProfileId: "p1", resolvedApiKey: "a" },
      after: { auth: undefined, authProfileId: "p1", resolvedApiKey: "b" },
      restart: false,
    },
    {
      name: "default home",
      before: { agentDir: undefined, copilotHome: undefined, agentId: "main" },
      after: { agentDir: undefined, copilotHome: undefined, agentId: "ops" },
      restart: true,
    },
  ])("invalidates reuse after changing $name", async ({ before, after, restart }) => {
    const store = makeSessionStoreMock(),
      f = fixture(store);
    nextSession("sdk");
    await f.run(before);
    await (restart ? fixture(store) : f).run(after);
    expect(replay(1)?.sdkSessionId).toBeUndefined();
  });

  it("persists validated bindings across restart and resets despite SDK deletion failure", async () => {
    const { createPluginStateKeyedStoreForTests: open, resetPluginStateStoreForTests: clear } =
      await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    const { closeOpenClawStateDatabaseAsync: close } =
      await import("openclaw/plugin-sdk/sqlite-runtime-testing");
    const options = {
      namespace: "sdk-sessions",
      maxEntries: 5000,
      defaultTtlMs: 90 * 86400_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("copilot-binding-") },
    };
    const firstStore = open<CopilotSessionBinding>("copilot", options);
    let currentStore = firstStore;
    const remove = vi.fn().mockRejectedValue(new Error("session not found"));
    const checkpoint = { journalValidated: true, sdkSessionId: "sdk" };
    mocks.attempt.mockImplementation(async (_input, deps) => {
      await deps.onSessionEstablished?.(publication("sdk", client({ deleteSession: remove })));
      expect((await currentStore.lookup("oc"))?.journalVersion).toBeUndefined();
      return { ...RESULT, ...checkpoint };
    });
    const first = createCopilotAgentHarness({ sessionStore: firstStore });
    try {
      await first.runAttempt(params());
      expect(await firstStore.lookup("oc")).toMatchObject({
        schemaVersion: 2,
        journalVersion: 1,
        sdkSessionId: "sdk",
      });
      await first.dispose?.();
      await first.reset?.({ sessionId: "oc" });
      expect(remove).not.toHaveBeenCalled();
      await close();
      clear();
      currentStore = open<CopilotSessionBinding>("copilot", options);
      const secondPool = poolMock();
      const second = createCopilotAgentHarness({ pool: secondPool, sessionStore: currentStore });
      await expect(second.compact?.(params())).resolves.toEqual(failed("missing_thread_binding"));
      expect(secondPool.acquire).not.toHaveBeenCalled();
      expect(await currentStore.lookup("oc")).toMatchObject({ sdkSessionId: "sdk" });
      await second.runAttempt(params());
      expect(replay(1)).toEqual(checkpoint);
      await expect(second.reset?.({ sessionId: "oc" })).resolves.toBeUndefined();
      await expect(second.reset?.({ sessionId: "oc" })).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledExactlyOnceWith("sdk");
      expect(await currentStore.lookup("oc")).toBeUndefined();
      await second.dispose?.();
      expect(secondPool.dispose).not.toHaveBeenCalled();
    } finally {
      await first.dispose?.();
      await close();
      clear();
    }
  });

  it("fingerprints BYOK URLs and invalidates changed request auth", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store, false, {
        provider: MODEL.provider,
        auth: undefined,
        authProfileId: "proxy:main",
        resolvedApiKey: "byok-token",
      });
    nextSession("sdk");
    const model = { ...MODEL, baseUrl: MODEL.baseUrl + "?routing=blue" };
    await f.run({
      model: attachModelProviderRequestTransport(model, { auth: { mode: "provider-default" } }),
    });
    const key = store.entries.get("oc")?.compatKey;
    expect(key).toContain("baseUrlFingerprint=sha256:");
    expect(key).not.toContain("proxy.example");
    expect(key).not.toContain("routing=blue");
    await f.run({
      model: attachModelProviderRequestTransport(model, {
        auth: { mode: "header", headerName: "x-api-key", value: "byok-token" },
      }),
    });
    expect(replay(1)?.sdkSessionId).toBeUndefined();
  });

  it("resumes shipped v1 bindings", async () => {
    const store = makeSessionStoreMock(),
      first = fixture(store);
    nextSession("sdk");
    await first.run();
    const saved = store.entries.get("oc");
    if (!saved) {
      throw new Error("expected persisted binding");
    }
    store.entries.set("oc", {
      schemaVersion: 1,
      sdkSessionId: "legacy",
      compatKey: saved.compatKey,
      updatedAt: Date.now(),
    } as never);
    await fixture(store).run();
    expect(replay(1)?.sdkSessionId).toBe("legacy");
  });

  it("starts fresh when persisted lookup fails", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store);
    store.store.lookup.mockRejectedValue(new Error("sqlite read failed"));
    await expect(f.run()).resolves.toBe(RESULT);
    expect(replay(0)?.sdkSessionId).toBeUndefined();
    expect(store.store.delete).toHaveBeenCalledWith("oc");
  });

  it("does not let stale persisted state override newer incompatible tracked state", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store);
    nextSession("sdk");
    await f.run();
    const saved = store.entries.get("oc");
    expect(saved).toBeDefined();
    nextSession("sdk");
    await f.run({ model: { provider: "github-copilot", id: "claude-sonnet-4.5" } });
    store.entries.set("oc", saved!);
    await f.run();
    expect(replay(2)?.sdkSessionId).toBeUndefined();
  });

  it("blocks persisted reuse when reset cannot delete its binding", async () => {
    const store = makeSessionStoreMock(),
      first = fixture(store);
    nextSession("sdk");
    await first.run();
    expect(store.entries.get("oc")?.sdkSessionId).toBe("sdk");
    store.store.delete.mockRejectedValue(new Error("sqlite delete failed"));
    const second = fixture(store);
    await second.reset();
    await second.run();
    expect(replay(1)?.sdkSessionId).toBeUndefined();
  });

  it("rejects compaction without a session id", async () => {
    const f = fixture();
    expect(await f.compact({ sessionId: undefined })).toEqual({
      ok: false,
      compacted: false,
      reason: "missing-required-params",
    });
  });

  it("clears the reset block even when storing its replacement fails", async () => {
    const store = makeSessionStoreMock(),
      f = fixture(store),
      bg = background("before");
    store.store.register.mockRejectedValue(new Error("sqlite register failed"));
    nextSession("before", { after: (deps) => deps.onDeferredCompaction?.(bg.event) });
    nextSession("replacement");
    nextSession("replacement");
    await f.run();
    await f.run();
    await f.run();
    expect(replay(1)?.sdkSessionId).not.toBe("before");
    expect(replay(2)?.sdkSessionId).toBe("replacement");
    bg.cleanup.resolve("completed");
    await flush();
  });

  it("compacts SDK history without workspace sidecars and emits lifecycle hooks", async () => {
    const before = vi.fn(),
      after = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_compaction", handler: before },
        { hookName: "after_compaction", handler: after },
      ]),
    );
    const details = {
      success: true,
      tokensRemoved: 123,
      messagesRemoved: 4,
      summaryContent: "compacted summary",
      contextWindow: { tokenLimit: 1000, currentTokens: 777, messagesLength: 12 },
    };
    const f = compaction(details, undefined, { agentId: "main", sessionKey: "agent:main:main" });
    f.disconnect.mockRejectedValue(new Error("disconnect failed"));
    f.establish();
    await f.run();
    const result = await f.compact({
      currentTokenCount: 900,
      workspaceDir: "/this\u0000is/illegal",
      customInstructions: "Keep decisions.",
    });
    expect(f.resumeSession).toHaveBeenCalledWith(
      "sdk",
      expect.objectContaining({
        continuePendingWork: false,
        suppressResumeEvent: true,
      }),
    );
    expect(f.compactRpc).toHaveBeenCalledWith({ customInstructions: "Keep decisions." });
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.pool.release).toHaveBeenCalledOnce();
    expect(before).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: "/session.json" },
      expect.objectContaining({
        sessionId: "oc",
        sessionKey: "agent:main:main",
      }),
    );
    expect(after).toHaveBeenCalledWith(
      { compactedCount: 4, messageCount: -1, sessionFile: "/session.json" },
      expect.objectContaining({ sessionId: "oc" }),
    );
    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      reason: "copilot-sdk-history-compacted",
      result: { summary: "compacted summary", tokensBefore: 900, tokensAfter: 777 },
    });
  });

  it("disconnects and releases when canceled after resume", async () => {
    const f = compaction(),
      abort = new AbortController();
    f.resumeSession.mockImplementation(async () => {
      abort.abort(new Error("stop compact"));
      return f.session;
    });
    f.establish();
    await f.run();
    expect(await f.compact({ abortSignal: abort.signal })).toEqual(
      failed("copilot-sdk-history-compact-failed", "stop compact"),
    );
    expect(f.resumeSession).toHaveBeenCalledOnce();
    expect(f.compactRpc).not.toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.pool.release).toHaveBeenCalledOnce();
  });

  it("requires matching token auth before compaction", async () => {
    const f = compaction();
    f.establish();
    await f.run({
      auth: {
        gitHubToken: "ghp_test",
        profileId: "p1",
        profileVersion: tokenFingerprint("ghp_test"),
      },
    });
    expect(await f.compact({ auth: undefined })).toEqual(failed("missing_thread_binding"));
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.resumeSession).not.toHaveBeenCalled();
    expect(
      (await f.compact({ auth: undefined, authProfileId: "p1", resolvedApiKey: "ghp_test" }))
        ?.compacted,
    ).toBe(true);
    expect(f.resumeSession).toHaveBeenCalledWith(
      "sdk",
      expect.objectContaining({ gitHubToken: "ghp_test" }),
    );
  });

  it("rejects rotated BYOK endpoints and uses a fresh proxy for matching compaction", async () => {
    const f = compaction(undefined, undefined, {
      provider: MODEL.provider,
      authProfileId: "byok:proxy",
      resolvedApiKey: "byok-token",
    });
    const provider = {
      type: "openai" as const,
      wireApi: "responses" as const,
      baseUrl: MODEL.baseUrl,
      modelId: MODEL.id,
      wireModel: MODEL.id,
    };
    const close = vi.fn(async () => undefined);
    mocks.proxy.mockImplementation(async (resolved: any) => ({
      close,
      provider: {
        ...resolved,
        provider: { ...resolved.provider, baseUrl: "http://127.0.0.1:49152/proxy/v1" },
      },
    }));
    f.establish("sdk", { config: { ...CONFIG, provider } });
    await f.run({ model: MODEL });
    expect(
      await f.compact({
        model: MODEL.id,
        runtimeModel: { ...MODEL, baseUrl: "https://rotated.example/v1" },
      }),
    ).toEqual(failed("missing_thread_binding"));
    expect(f.resumeSession).not.toHaveBeenCalled();
    expect((await f.compact({ model: MODEL.id, runtimeModel: MODEL }))?.compacted).toBe(true);
    expect(mocks.proxy).toHaveBeenCalledWith({ mode: "byok", provider });
    expect(f.resumeSession).toHaveBeenCalledWith(
      "sdk",
      expect.objectContaining({
        provider: expect.objectContaining({ baseUrl: "http://127.0.0.1:49152/proxy/v1" }),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "invalidates stale compaction without deleting a replacement (%s)",
    async (replacement) => {
      const store = makeSessionStoreMock(),
        f = compaction(undefined, store);
      const resume = createDeferred<void>(),
        admitted = createDeferred<void>();
      f.resumeSession.mockImplementation(async () => {
        admitted.resolve();
        await resume.promise;
        throw new Error("session not found");
      });
      f.establish("stale", {
        result: { ...RESULT, sdkSessionId: "stale", journalValidated: true },
      });
      await f.run();
      const pending = f.compact();
      await admitted.promise;
      const id = replacement ? "replacement" : "stale";
      f.establish(id, { result: { ...RESULT, sdkSessionId: id, journalValidated: true } });
      await f.run();
      resume.resolve();
      expect(await pending).toEqual(failed("stale_thread_binding", "session not found"));
      expect(store.entries.get("oc")?.sdkSessionId).toBe(replacement ? "replacement" : undefined);
    },
  );

  it("aborts the SDK manual compaction when canceled", async () => {
    const f = compaction(),
      abort = new AbortController(),
      pending = createDeferred<never>();
    f.compactRpc.mockImplementation(() => pending.promise);
    const abortManualCompaction = vi.fn(async () => {
      pending.reject(new Error("manual compaction aborted"));
      return { aborted: true };
    });
    f.resumeSession.mockImplementation(async () => ({
      disconnect: f.disconnect,
      rpc: { history: { compact: f.compactRpc, abortManualCompaction } },
    }));
    f.establish();
    await f.run();
    const result = f.compact({ abortSignal: abort.signal });
    await vi.waitFor(() => expect(f.compactRpc).toHaveBeenCalledOnce());
    abort.abort(new Error("caller canceled"));
    expect(await result).toEqual(failed("copilot-sdk-history-compact-failed", "caller canceled"));
    expect(abortManualCompaction).toHaveBeenCalledOnce();
  });

  it("reports SDK compaction no-ops without compatibility sidecars", async () => {
    const f = compaction({ success: true, tokensRemoved: 0, messagesRemoved: 0 });
    f.establish();
    await f.run();
    expect(await f.compact({ workspaceDir: "/this\u0000is/illegal" })).toEqual({
      ok: true,
      compacted: false,
      reason: "already under target",
    });
    expect(f.compactRpc).toHaveBeenCalledWith(undefined);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
