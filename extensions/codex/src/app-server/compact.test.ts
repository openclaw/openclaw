import path from "node:path";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCodexAppServerAuthProfile } from "./auth-bridge.js";
import {
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  beginCompactionTestCleanup,
  compactStartRequestOptions,
  compactUnboundedRequestOptions,
  compactCodexSessionWithTestHost as maybeCompactCodexAppServerSessionImpl,
  compactionItemEvent,
  compactionParams as createCompactionParams,
  expectCompactStartRequest,
  createFakeCodexCompactionClient,
  createNodeExecCompactionParams,
  createRemoteExecCompactionParams,
  createSandboxedCompactionParams,
  expectExternalMutationBlockedDuringNativeRequest,
  flushAsyncTasks,
  maybeCompactCodexAppServerSession,
  requireCompactResult,
  recoveredCompactionBinding,
  resetCodexAppServerClientFactoryForTest,
  setCodexAppServerClientFactoryForTest,
  writeCompactionTestBinding,
  writeSupervisedTestBinding,
} from "./compact.test-support.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER } from "./responses-oauth.js";
import { resolveCodexSessionBinding } from "./session-binding.js";
import {
  clearCodexAppServerBindingForThread,
  createCodexTestBindingStore,
  createCodexTestContextEngineBinding as contextEngineBinding,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import * as threadOwnershipQueue from "./thread-ownership-queue.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-compact-");

let tempDir: string;
let finishCompactionTestCleanup: ReturnType<typeof beginCompactionTestCleanup>;
const createFakeCodexClient = (options?: Parameters<typeof createFakeCodexCompactionClient>[1]) =>
  createFakeCodexCompactionClient(tempDir, options);

const INCOGNITO_COMPACT_KEY = "agent:main:dashboard:incognito-compact-catalog";

async function writeTestBinding(
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  sessionKey = "agent:main:session-1",
): Promise<string> {
  return writeCompactionTestBinding(tempDir, options, sessionKey);
}

function compactionParams(
  sessionFile: string,
  overrides: Partial<Parameters<typeof maybeCompactCodexAppServerSession>[0]> = {},
) {
  return createCompactionParams(tempDir, sessionFile, overrides);
}

function emitTurn(
  fake: ReturnType<typeof createFakeCodexClient>,
  id: string,
  status: "inProgress" | "completed" | "interrupted" | "failed",
  threadId = "thread-1",
) {
  fake.emit({
    method: status === "inProgress" ? "turn/started" : "turn/completed",
    params: {
      threadId,
      turn: status === "inProgress" ? { id, threadId, status } : { id, status, items: [] },
    },
  });
}

function startCompaction(
  sessionFile: string,
  options: {
    currentTokenCount?: number;
    nativeToolSurface?: "unrestricted" | "host-isolated";
    pluginConfig?: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]["pluginConfig"];
  } = {},
) {
  const { pluginConfig, ...paramsOptions } = options;
  return maybeCompactCodexAppServerSession(
    compactionParams(sessionFile, paramsOptions),
    pluginConfig ? { pluginConfig } : {},
  );
}

async function compactResult(...args: Parameters<typeof maybeCompactCodexAppServerSession>) {
  return requireCompactResult(await maybeCompactCodexAppServerSession(...args));
}

async function setupCompaction(
  clientOptions?: Parameters<typeof createFakeCodexClient>[0],
  bindingOptions?: Parameters<typeof writeTestBinding>[0],
) {
  const fake = createFakeCodexClient(clientOptions);
  const factory = vi.fn<CodexAppServerClientFactory>(async () => fake.client);
  setCodexAppServerClientFactoryForTest(factory);
  return { fake, factory, sessionFile: await writeTestBinding(bindingOptions) };
}

function admittedParams(
  current: { sessionId: string; sessionKey: string; agentId: string },
  scope: { storePath: string },
  filename = "recovered.jsonl",
) {
  return compactionParams(path.join(tempDir, filename), {
    sessionId: current.sessionId,
    sessionKey: current.sessionKey,
    agentId: current.agentId,
    sessionTarget: { ...scope, sessionId: current.sessionId },
  });
}

function expectFailed(result: unknown, reason: unknown) {
  expect(result).toMatchObject({ ok: false, compacted: false, reason });
}

function waitForStart(fake: ReturnType<typeof createFakeCodexClient>) {
  return vi.waitFor(() =>
    expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions),
  );
}

function expectInterrupt(
  fake: ReturnType<typeof createFakeCodexClient>,
  turnId: string,
  timeoutMs = 30_000,
) {
  expect(fake.request).toHaveBeenCalledWith(
    "turn/interrupt",
    { threadId: "thread-1", turnId },
    { timeoutMs },
  );
}

function runtimeAuthPlan(
  authRequirement: "api-key" | "subscription" = "api-key",
): NonNullable<Parameters<typeof maybeCompactCodexAppServerSession>[0]["runtimeAuthPlan"]> {
  return {
    providerForAuth: "openai",
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: authRequirement,
    modelRoute: {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement,
      requestTransportOverrides: "none",
    },
  };
}

function replaceBindingAfterRead(sessionFile: string) {
  let bindingReads = 0;
  return {
    ...testCodexAppServerBindingStore,
    readAsync: vi.fn(
      async (...args: Parameters<typeof testCodexAppServerBindingStore.readAsync>) => {
        const result = await testCodexAppServerBindingStore.readAsync(...args);
        if (bindingReads++ === 0) {
          seedCodexTestBinding(sessionFile, {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              ...contextEngineBinding(),
              projection: {
                schemaVersion: 1,
                mode: "thread_bootstrap",
                epoch: "epoch-2",
                fingerprint: "fingerprint-2",
              },
            },
          });
        }
        return result;
      },
    ),
  };
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    resetCodexTestBindingStore();
    tempDir = sessionDirs.make();
    finishCompactionTestCleanup = beginCompactionTestCleanup();
  });

  afterEach(async ({ task }) => {
    try {
      await finishCompactionTestCleanup(task.result?.state === "fail");
    } finally {
      resetCodexAppServerClientFactoryForTest();
      clearRuntimeConfigSnapshot();
    }
  });

  it("rejects a host-only rotation after recovering the predecessor during compaction startup", async () => {
    const { current, scope, bindingStore, binding } = await recoveredCompactionBinding(
      tempDir,
      "agent:main:recovered-compaction",
    );
    const fake = createFakeCodexClient({ retainedThreadId: null });

    const result = await maybeCompactCodexAppServerSessionImpl(admittedParams(current, scope), {
      bindingStore,
      clientFactory: async () => {
        expect(bindingStore.read(current)).toEqual(binding);
        await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
        return fake.client;
      },
    });

    expect(
      fake.request.mock.calls.some(([method]) =>
        ["thread/resume", "thread/compact/start"].includes(method),
      ),
    ).toBe(false);
    expectFailed(
      result,
      expect.stringMatching(
        /Codex session (generation is no longer current|execution policy changed)/,
      ),
    );
    expect(bindingStore.read(current)).toEqual(binding);
  });

  it("rejects a queued compaction after admitted authority rotates before client acquisition", async () => {
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:queued-authority",
      sessionId: "session-current",
    };
    const successor = { ...current, sessionId: "session-successor" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    await upsertSessionEntry({ ...scope, entry: { sessionId: current.sessionId, updatedAt: 1 } });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "thread-queued", cwd: tempDir };
    await bindingStore.mutate(current, { kind: "set", binding });
    const fake = createFakeCodexClient();
    const clientFactory = vi.fn(async () => fake.client);
    const queueEntered = createDeferred<void>();
    const releaseQueue = createDeferred<void>();
    const held = withCodexAppServerThreadMutation(binding.threadId, async () => {
      queueEntered.resolve();
      await releaseQueue.promise;
    });
    await queueEntered.promise;

    const compactionQueued = createDeferred<void>();
    const enqueueMutation = threadOwnershipQueue.withCodexAppServerThreadMutation;
    const queueSpy = vi
      .spyOn(threadOwnershipQueue, "withCodexAppServerThreadMutation")
      .mockImplementation((threadId, run) => {
        const pending = enqueueMutation(threadId, run);
        if (threadId === binding.threadId) {
          compactionQueued.resolve();
        }
        return pending;
      });
    const pending = maybeCompactCodexAppServerSessionImpl(
      admittedParams(current, scope, "queued-authority.jsonl"),
      { bindingStore, clientFactory },
    );
    try {
      await compactionQueued.promise;
      expect(clientFactory).not.toHaveBeenCalled();

      await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
    } finally {
      queueSpy.mockRestore();
      releaseQueue.resolve();
      await held;
    }

    await expect(pending).rejects.toThrow(
      "Codex session execution policy changed; prepare the operation again.",
    );
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fake.request).not.toHaveBeenCalled();
    expect(bindingStore.read(current)).toEqual(binding);

    const adopted = await resolveCodexSessionBinding({
      bindingStore,
      identity: successor,
      storePath: scope.storePath,
    });
    using _ = { [Symbol.dispose]: () => adopted.release() };
    expect(adopted.binding).toEqual(binding);
    expect(bindingStore.read(successor)).toEqual(binding);
  });

  it("explains manual subscription-sharing compaction without starting native inference", async () => {
    const { fake, sessionFile } = await setupCompaction(undefined, {
      modelProvider: CODEX_RESPONSES_OAUTH_PROVIDER,
    });

    await expect(startCompaction(sessionFile)).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("Automatic compaction runs during normal turns"),
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it.each(["binding", "operation"] as const)(
    "does not compact native authority restricted by the %s",
    async (restriction) => {
      const { fake, sessionFile } = await setupCompaction(
        undefined,
        restriction === "binding" ? { nativeToolPolicyRestricted: true } : {},
      );
      await expect(
        startCompaction(
          sessionFile,
          restriction === "operation" ? { nativeToolSurface: "host-isolated" } : {},
        ),
      ).resolves.toMatchObject({
        ok: true,
        compacted: false,
        reason: "native compaction is unavailable for a host-isolated Codex session",
      });
      expect(fake.request).not.toHaveBeenCalled();
    },
  );

  it("keeps an owned thread subscribed when a sibling finishes during compaction", async () => {
    const { fake, sessionFile } = await setupCompaction({ autoCompleteCompaction: false });
    const pending = startCompaction(sessionFile);
    await waitForStart(fake);

    await fake.client.request("thread/resume", { threadId: "thread-2", excludeTurns: true });
    await retainCodexAppServerLiveThread(fake.client, "thread-2", undefined, "config-thread-2");
    fake.completeCompaction();

    await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    expect(fake.request).not.toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      expect.anything(),
    );
    await expect(
      consumeCodexAppServerLiveThread(fake.client, "thread-1", "config-thread-1"),
    ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-1" }));
    await expect(
      consumeCodexAppServerLiveThread(fake.client, "thread-2", "config-thread-2"),
    ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-2" }));
  });

  it("releases an obsolete physical owner when compaction migrates the same native thread", async () => {
    const { fake, sessionFile } = await setupCompaction(
      { autoCompleteCompaction: false },
      { clientId: "client-before-compaction" },
    );
    const pending = startCompaction(sessionFile);
    await waitForStart(fake);

    seedCodexTestBinding(sessionFile, {
      threadId: "thread-1",
      clientId: "client-after-compaction",
      cwd: tempDir,
    });
    fake.completeCompaction();

    await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    await expect(consumeCodexAppServerLiveThread(fake.client, "thread-1")).resolves.toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      clientId: "client-after-compaction",
    });
  });

  it.each([
    // Incognito retains its subscription; ordinary sessions reclaim it during compaction.
    { label: "an edited catalog", refreshed: "catalog B", sessionKey: INCOGNITO_COMPACT_KEY },
    { label: "a withdrawn catalog", refreshed: undefined, sessionKey: "agent:main:session-1" },
  ])(
    "records $label as reverted after standalone compaction on $sessionKey",
    async ({ refreshed, sessionKey }) => {
      const fake = createFakeCodexClient();
      setCodexAppServerClientFactoryForTest(async () => fake.client);
      const sessionFile = await writeCompactionTestBinding(tempDir, {}, sessionKey);
      const ephemeralPolicy = {
        developerInstructions: "generic policy",
        refreshableInstructions: refreshed,
        nativeRefreshableInstructions: "catalog A",
      };
      await retainCodexAppServerLiveThread(
        fake.client,
        "thread-1",
        undefined,
        "config-thread-1",
        null,
        ephemeralPolicy,
      );

      await expect(
        maybeCompactCodexAppServerSession(compactionParams(sessionFile, { sessionKey })),
      ).resolves.toMatchObject({ ok: true, compacted: true });

      // Revert to creation policy so the next turn injects the current catalog again.
      await expect(
        consumeCodexAppServerLiveThread(fake.client, "thread-1", "config-thread-1"),
      ).resolves.toEqual(
        expect.objectContaining({
          ephemeralPolicy: {
            developerInstructions: "generic policy",
            refreshableInstructions: "catalog A",
            nativeRefreshableInstructions: "catalog A",
          },
        }),
      );
    },
  );

  it.each(["prepared-platform-key", undefined])(
    "uses only the prepared Platform key (%s)",
    async (resolvedApiKey) => {
      const { factory, sessionFile } = await setupCompaction();
      const result = await compactResult(
        compactionParams(sessionFile, {
          provider: "openai",
          model: "gpt-5.5",
          resolvedApiKey,
          runtimeAuthPlan: runtimeAuthPlan(),
        }),
        { clientFactory: factory },
      );
      if (resolvedApiKey) {
        expect(result.ok).toBe(true);
        expect(factory).toHaveBeenCalledWith(
          expect.objectContaining({
            preparedAuth: { kind: "api-key", apiKey: resolvedApiKey },
            authRequirement: "api-key",
          }),
        );
        expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("authProfileId");
      } else {
        expectFailed(
          result,
          "Prepared Codex Platform compaction route is missing its resolved API key.",
        );
        expect(factory).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [true, "api-key"],
    [false, "api-key"],
    [false, "subscription"],
  ] as const)(
    "keeps native auth ownership (supervision: %s, outer: %s)",
    async (supervised, authRequirement) => {
      const fake = createFakeCodexClient({ retainedThreadId: null });
      const factory = vi.fn<CodexAppServerClientFactory>(async (options) => {
        if (options?.authRequirement) {
          fake.request.mockResolvedValueOnce({
            account: { type: authRequirement === "api-key" ? "chatgpt" : "apiKey" },
          });
        }
        // Exercise the real startup verifier against the conflicting native account.
        await applyCodexAppServerAuthProfile({
          client: fake.client,
          authProfileId: options?.authProfileId,
          authRequirement: options?.authRequirement,
        });
        return fake.client;
      });
      const sessionFile = supervised
        ? await writeSupervisedTestBinding(tempDir, { authProfileId: "openai:binding-profile" })
        : await writeCompactionTestBinding(tempDir);
      const pending = maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          authProfileId: "openai:outer-profile",
          runtimeAuthPlan: runtimeAuthPlan(authRequirement),
        }),
        {
          clientFactory: factory,
          pluginConfig: supervised
            ? { supervision: { enabled: true } }
            : { appServer: { homeScope: "user" } },
        },
      );
      if (supervised) {
        await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
      } else {
        await expect(pending).rejects.toThrow(/Codex (Platform|subscription) route requires/);
      }
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: null,
          authRequirement: supervised ? undefined : authRequirement,
          startOptions: expect.objectContaining({ homeScope: "user" }),
        }),
      );
      expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("preparedAuth");
    },
  );

  it("fails closed when a supervised binding is no longer enabled", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeSupervisedTestBinding(tempDir);

    const result = await compactResult(compactionParams(sessionFile), {
      clientFactory: factory,
      pluginConfig: { supervision: { enabled: false } },
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason:
        "Codex supervision is disabled; refusing to open a native user-home supervised session",
    });
    expect(factory).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
    });
  });

  it("releases the rejected compaction watcher when binding restoration fails", async () => {
    const { fake, sessionFile } = await setupCompaction();
    fake.request.mockRejectedValueOnce(
      new CodexAppServerRpcError(
        { code: -32_600, message: "compaction temporarily unavailable" },
        "thread/compact/start",
      ),
    );
    const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
    const mutateSpy = vi
      .spyOn(testCodexAppServerBindingStore, "mutate")
      .mockImplementation(async (...args) => {
        if (args[1].kind === "set") {
          throw new Error("binding restoration refused");
        }
        return await mutate(...args);
      });
    const removeCloseHandler = vi.fn();
    vi.spyOn(fake.client, "addCloseHandler").mockReturnValue(removeCloseHandler);

    try {
      await expect(startCompaction(sessionFile)).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "binding restoration refused",
      });
      expect(removeCloseHandler).toHaveBeenCalledOnce();
    } finally {
      mutateSpy.mockRestore();
      fake.completeCompaction();
    }
  });

  it.each(["aborted", "binding changed", "required preflight"] as const)(
    "preserves projection before guarded native compaction: %s",
    async (scenario) => {
      const { fake, sessionFile } = await setupCompaction(undefined, {
        contextEngine: contextEngineBinding(),
      });
      const aborted = scenario === "aborted";
      const preflightRequired = scenario === "required preflight";
      const suffix = aborted ? "1" : "2";
      const result = await compactResult(
        compactionParams(sessionFile, {
          trigger: "budget",
          currentTokenCount: 456,
          ...(preflightRequired ? { preflightRequired: true } : {}),
          ...(aborted ? { abortSignal: AbortSignal.abort("cancelled") } : {}),
        }),
        {
          allowNonManualNativeRequest: true,
          ...(aborted ? {} : { bindingStore: replaceBindingAfterRead(sessionFile) }),
          ...(preflightRequired ? { nativeCompactionRequest: "required_preflight" } : {}),
        },
      );
      expect(fake.request).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: !preflightRequired,
        compacted: false,
        reason: `codex app-server ${aborted ? "compaction aborted" : "binding changed"} before native compaction`,
      });
      if (preflightRequired) {
        // Preflight has not compacted yet: fallback requires a failure, not a benign skip.
        expect(result.failure?.reason).toBe("stale_thread_binding");
      }
      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        threadId: `thread-${suffix}`,
        contextEngine: {
          projection: { epoch: `epoch-${suffix}`, fingerprint: `fingerprint-${suffix}` },
        },
      });
    },
  );

  it.each(["writes", "clears"])(
    "blocks same-process binding %s until guarded native compaction starts",
    async (mutation) => {
      const externalMutationGate = createDeferred<void>();
      let externalMutationStarted = false;
      let externalMutationFinished = false;
      const fake = createFakeCodexClient();
      fake.request.mockImplementation(async (method) => {
        if (method === "thread/unsubscribe") {
          return {};
        }
        const response = await expectExternalMutationBlockedDuringNativeRequest({
          releaseExternalMutation: externalMutationGate.resolve,
          isExternalMutationStarted: () => externalMutationStarted,
          isExternalMutationFinished: () => externalMutationFinished,
        });
        setImmediate(fake.completeCompaction);
        return response;
      });
      setCodexAppServerClientFactoryForTest(async () => fake.client);
      const sessionFile = await writeTestBinding({
        contextEngine: contextEngineBinding(),
      });
      const externalMutation = (async () => {
        await externalMutationGate.promise;
        externalMutationStarted = true;
        if (mutation === "writes") {
          await writeCodexAppServerBinding(sessionFile, {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-2",
              projection: {
                schemaVersion: 1,
                mode: "thread_bootstrap",
                epoch: "epoch-2",
              },
            },
          });
        } else {
          await expect(clearCodexAppServerBindingForThread(sessionFile, "thread-1")).resolves.toBe(
            true,
          );
        }
        externalMutationFinished = true;
      })();

      const result = await compactResult(
        compactionParams(sessionFile, {
          trigger: "budget",
          currentTokenCount: 456,
        }),
        { allowNonManualNativeRequest: true },
      );

      await externalMutation;
      expectCompactStartRequest(fake.request, "thread-1", compactStartRequestOptions);
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
      if (mutation === "writes") {
        expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
          threadId: "thread-2",
          contextEngine: {
            policyFingerprint: "policy-2",
            projection: {
              epoch: "epoch-2",
            },
          },
        });
      } else {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      }
    },
  );

  it("skips native app-server compaction when trigger is omitted", async () => {
    const { fake, sessionFile } = await setupCompaction();

    const result = await compactResult(
      compactionParams(sessionFile, {
        trigger: undefined,
        currentTokenCount: 789,
      }),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
    });
    expect(result.result?.tokensBefore).toBe(789);
  });

  it.each([
    ["configured sandbox", createSandboxedCompactionParams, "sandboxing"],
    ["remote-exec sandbox", createRemoteExecCompactionParams, "sandboxing"],
    ["node exec", createNodeExecCompactionParams, "exec host=node"],
    [
      "retained explicit-roster policy owner",
      (_dir: string, sessionFile: string) =>
        compactionParams(sessionFile, {
          sessionKey: "agent:beta:session-1",
          agentId: "beta",
          sandboxSessionKey: "global",
          sandboxAgentId: "alpha",
          config: {
            tools: { exec: { host: "gateway" } },
            agents: {
              entries: {
                alpha: { tools: { exec: { host: "node", node: "worker-1" } } },
                beta: {},
              },
            },
          },
        }),
      "exec host=node",
    ],
  ] as const)("blocks native app-server compaction for %s", async (_label, params, reason) => {
    const { fake, sessionFile } = await setupCompaction();
    expectFailed(
      await compactResult(params(tempDir, sessionFile)),
      expect.stringContaining(
        `Codex-native native compaction is unavailable because OpenClaw ${reason} is active for this session.`,
      ),
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("does not finish until the matching native compaction turn completes", async () => {
    const { fake, sessionFile } = await setupCompaction({ autoCompleteCompaction: false });

    let settled = false;
    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 }).finally(() => {
      settled = true;
    });
    await waitForStart(fake);
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit(compactionItemEvent("item/started", "turn-1"));
    for (const totalTokens of [999, 321]) {
      fake.emit({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { totalTokens } } },
      });
    }
    fake.emit(compactionItemEvent("item/completed", "turn-1"));
    await flushAsyncTasks();
    expect(settled).toBe(false);
    emitTurn(fake, "turn-1", "completed");
    const result = requireCompactResult(await pendingResult);

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(result.result?.tokensAfter).toBe(321);
  });

  it.each(["early abort", "already-terminal interrupt"] as const)(
    "holds the queue until native termination after %s",
    async (scenario) => {
      const terminal = scenario === "already-terminal interrupt";
      const { fake, sessionFile } = await setupCompaction({
        autoCompleteCompaction: false,
        interruptError: terminal
          ? new CodexAppServerRpcError(
              { code: -32_600, message: "no active turn to interrupt" },
              "turn/interrupt",
            )
          : undefined,
      });
      const abortController = new AbortController();
      let settled = false;
      const pendingResult = maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, { abortSignal: abortController.signal }),
      ).finally(() => {
        settled = true;
      });
      await waitForStart(fake);
      if (!terminal) {
        abortController.abort();
        await flushAsyncTasks();
        expect(settled).toBe(false);
      }
      emitTurn(fake, "compact-turn-finished", "inProgress");
      if (terminal) {
        for (const method of ["item/started", "item/completed"] as const) {
          fake.emit(compactionItemEvent(method, "compact-turn-finished", "compact-item-finished"));
        }
        abortController.abort();
      }
      let successorRan = false;
      const successor = withCodexAppServerThreadMutation("thread-1", async () => {
        successorRan = true;
      });
      try {
        await vi.waitFor(() => expectInterrupt(fake, "compact-turn-finished"));
        expect(settled).toBe(false);
        expect(successorRan).toBe(false);
      } finally {
        emitTurn(fake, "compact-turn-finished", terminal ? "completed" : "interrupted");
        await pendingResult;
        await successor;
      }

      expect(await pendingResult).toMatchObject(
        terminal
          ? { ok: true, compacted: true }
          : {
              ok: false,
              compacted: false,
              reason: "codex app-server compaction turn ended with status interrupted",
            },
      );
      expect(fake.closeAndWait).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeDefined();
    },
  );

  it("uses the configured compaction timeout for native completion", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const nativeSetTimeout = globalThis.setTimeout;
    let triggerCompletionTimeout: (() => void) | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 1_000 && !triggerCompletionTimeout) {
          triggerCompletionTimeout = () => callback(...args);
          return nativeSetTimeout(() => undefined, 60_000);
        }
        return nativeSetTimeout(callback, delay, ...args);
      });

    try {
      const pendingResult = maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
        }),
        {
          clientFactory: async () => fake.client,
          nativeInterruptGraceMs: 10,
        },
      );
      await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
      emitTurn(fake, "compact-turn-configured", "inProgress");

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
      expect(triggerCompletionTimeout).toBeDefined();
      triggerCompletionTimeout?.();
      expectInterrupt(fake, "compact-turn-configured", 10);
      await expect(pendingResult).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "codex app-server compaction did not reach terminal state after interruption",
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves a recovered binding when the host rotates during timed-out remote retirement", async () => {
    const { current, scope, bindingStore, binding } = await recoveredCompactionBinding(
      tempDir,
      "agent:main:recovered-retirement",
    );
    const next = { ...current, sessionId: "next-compaction" };
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    const closeEntered = createDeferred<void>();
    const closeGate = createDeferred<void>();
    fake.closeAndWait.mockImplementationOnce(async () => {
      closeEntered.resolve();
      await closeGate.promise;
      return { exited: false, cleanup: "uncertain" };
    });
    const retirementOutcome = createDeferred<"retained" | "settled">();
    const errorSpy = vi.spyOn(embeddedAgentLog, "error").mockImplementation((message) => {
      if (message === "failed to retire unconfirmed codex app-server compaction") {
        retirementOutcome.resolve("retained");
      }
    });
    const pending = maybeCompactCodexAppServerSessionImpl(admittedParams(current, scope), {
      bindingStore,
      clientFactory: async () => fake.client,
      pluginConfig: {
        appServer: { transport: "websocket", url: "ws://127.0.0.1:45001" },
      },
      nativeCompletionTimeoutMs: 10,
      nativeInterruptGraceMs: 10,
    }).finally(() => retirementOutcome.resolve("settled"));
    const nextMutation = vi.fn(async () => {});
    let queued: Promise<void> | undefined;
    try {
      await closeEntered.promise;
      expect(bindingStore.read(current)).toEqual(binding);
      emitTurn(fake, "compact-turn-retired", "inProgress", binding.threadId);
      queued = withCodexAppServerThreadMutation(binding.threadId, nextMutation);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: next.sessionId }) });
      closeGate.resolve();

      const outcome = await retirementOutcome.promise;
      expect(bindingStore.read(current)).toEqual(binding);
      expect(outcome).toBe("retained");
      expect(nextMutation).not.toHaveBeenCalled();
    } finally {
      closeGate.resolve();
      emitTurn(fake, "compact-turn-retired", "interrupted", binding.threadId);
      await pending;
      await queued;
      errorSpy.mockRestore();
    }
    expect(nextMutation).toHaveBeenCalledOnce();
    const recovered = await resolveCodexSessionBinding({
      bindingStore,
      identity: next,
      storePath: scope.storePath,
    });
    using _ = { [Symbol.dispose]: () => recovered.release() };
    expect(recovered.binding).toEqual(binding);
    expect(bindingStore.read(next)).toEqual(binding);
  });

  it("keeps later compactions behind an active request after a queued waiter cancels", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const firstSessionFile = await writeCompactionTestBinding(tempDir);
    const secondSessionFile = path.join(tempDir, "canceled-queued-session.jsonl");
    const thirdSessionFile = path.join(tempDir, "later-session.jsonl");
    for (const [sessionFile, sessionId] of [
      [secondSessionFile, "session-2"],
      [thirdSessionFile, "session-3"],
    ] as const) {
      registerCodexTestSessionIdentity(sessionFile, sessionId, `agent:main:${sessionId}`);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-1",
        cwd: tempDir,
      });
    }
    const abortController = new AbortController();

    const first = startCompaction(firstSessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(1);
    });
    let mutationQueued = createDeferred<void>();
    const enqueueMutation = threadOwnershipQueue.withCodexAppServerThreadMutation;
    const queueSpy = vi
      .spyOn(threadOwnershipQueue, "withCodexAppServerThreadMutation")
      .mockImplementation((threadId, run) => {
        const pending = enqueueMutation(threadId, run);
        if (threadId === "thread-1") {
          mutationQueued.resolve();
        }
        return pending;
      });
    try {
      const second = maybeCompactCodexAppServerSession(
        compactionParams(secondSessionFile, {
          sessionId: "session-2",
          sessionKey: "agent:main:session-2",
          abortSignal: abortController.signal,
        }),
      );
      await mutationQueued.promise;
      expect(factory).toHaveBeenCalledTimes(1);
      abortController.abort();
      await expect(second).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "codex app-server compaction aborted while waiting to start",
      });

      mutationQueued = createDeferred<void>();
      const third = maybeCompactCodexAppServerSession(
        compactionParams(thirdSessionFile, {
          sessionId: "session-3",
          sessionKey: "agent:main:session-3",
        }),
      );
      await mutationQueued.promise;
      expect(factory).toHaveBeenCalledTimes(1);
      expect(fake.request).toHaveBeenCalledTimes(1);

      fake.completeCompaction();
      await expect(first).resolves.toMatchObject({ ok: true, compacted: true });
      await vi.waitFor(() => {
        expect(
          fake.request.mock.calls.filter(([method]) => method === "thread/compact/start"),
        ).toHaveLength(2);
      });

      fake.completeCompaction();
      await expect(third).resolves.toMatchObject({ ok: true, compacted: true });
    } finally {
      queueSpy.mockRestore();
    }
  });

  it("preserves stale thread binding metadata for recovery and reports failed native compaction", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(
      new CodexAppServerRpcError(
        { code: -32_600, message: "thread not found: thread-1" },
        "thread/compact/start",
      ),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const binding = {
      threadId: "thread-1",
      authProfileId: "openai:work",
      model: "gpt-5.5-mini",
      approvalPolicy: "on-request" as const,
      sandbox: "workspace-write" as const,
      serviceTier: "priority",
    };
    const sessionFile = await writeCompactionTestBinding(tempDir, binding);

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject(binding);
    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
    });
    expect(result.failure?.reason).toBe("stale_thread_binding");
    expect(result.result).toBeUndefined();
    expect(fake.closeAndWait).not.toHaveBeenCalled();
  });

  it("detaches a guarded remote start after releasing the binding lock", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread/compact/start timed out"));
    fake.closeAndWait.mockResolvedValueOnce({ exited: false, cleanup: "uncertain" });
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = await compactResult(
      compactionParams(sessionFile, {
        trigger: "budget",
      }),
      {
        allowNonManualNativeRequest: true,
        clientFactory: async () => fake.client,
        pluginConfig: {
          appServer: { transport: "websocket", url: "ws://127.0.0.1:45001" },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "thread/compact/start timed out",
    });
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("warns when stale OpenClaw compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const { sessionFile } = await setupCompaction();

    await maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, {
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openai/gpt-5.4",
                provider: "custom-summary",
                thinkingLevel: "ultra",
              },
            },
          },
        },
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ignoring OpenClaw compaction overrides"),
      expect.objectContaining({
        ignoredConfig: [
          "agents.defaults.compaction.model",
          "agents.defaults.compaction.thinkingLevel",
          "agents.defaults.compaction.provider",
        ],
      }),
    );
    warn.mockRestore();
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const { factory, sessionFile } = await setupCompaction(undefined, {
      authProfileId: "openai:binding",
    });

    const result = await maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, {
        authProfileId: "openai:runtime",
      }),
    );

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch for session binding",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("requires a Codex binding instead of delegating to an owning context engine", async () => {
    const compact = vi.fn();
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
    };

    const result = await maybeCompactCodexAppServerSession(
      compactionParams(path.join(tempDir, "missing-binding.jsonl"), { contextEngine }),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "missing_thread_binding" },
    });
    expect(compact).not.toHaveBeenCalled();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
