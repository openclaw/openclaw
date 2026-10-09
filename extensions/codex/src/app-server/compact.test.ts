import path from "node:path";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  compactDetails,
  expectCompactStartRequest,
  createFakeCodexCompactionClient,
  createNodeExecCompactionParams,
  createRemoteExecCompactionParams,
  createSandboxedCompactionParams,
  expectExternalMutationBlockedDuringNativeRequest,
  flushAsyncTasks,
  maybeCompactCodexAppServerSession,
  requireCompactResult,
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
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-compact-");

let tempDir: string;
let finishCompactionTestCleanup: ReturnType<typeof beginCompactionTestCleanup>;

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
): Parameters<typeof maybeCompactCodexAppServerSession>[0] {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    ...overrides,
  };
}

function contextEngineBinding() {
  return {
    schemaVersion: 1 as const,
    engineId: "lossless-claw",
    policyFingerprint: "policy-1",
    projection: {
      schemaVersion: 1 as const,
      mode: "thread_bootstrap" as const,
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    },
  };
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
    pluginConfig?: unknown;
  } = {},
) {
  const { pluginConfig, ...paramsOptions } = options;
  return maybeCompactCodexAppServerSession(
    compactionParams(sessionFile, paramsOptions),
    pluginConfig ? { pluginConfig } : {},
  );
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = sessionDirs.make();
    finishCompactionTestCleanup = beginCompactionTestCleanup();
  });

  afterEach(async ({ task }) => {
    try {
      await finishCompactionTestCleanup(task.result?.state === "fail");
    } finally {
      resetCodexAppServerClientFactoryForTest();
    }
  });

  it("rejects a host-only rotation after recovering the predecessor during compaction startup", async () => {
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:recovered-compaction",
      sessionId: "after-compaction",
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "thread-1", cwd: tempDir };
    await bindingStore.mutate(previous, { kind: "set", binding });
    const fake = createFakeCodexClient({ retainedThreadId: null });

    const result = await maybeCompactCodexAppServerSessionImpl(
      {
        sessionId: current.sessionId,
        sessionKey: current.sessionKey,
        agentId: current.agentId,
        sessionTarget: { ...scope, sessionId: current.sessionId },
        sessionFile: path.join(tempDir, "recovered.jsonl"),
        workspaceDir: tempDir,
        trigger: "manual",
      },
      {
        bindingStore,
        clientFactory: async () => {
          expect(bindingStore.read(current)).toEqual(binding);
          await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
          return fake.client;
        },
      },
    );

    expect(
      fake.request.mock.calls.some(([method]) =>
        ["thread/resume", "thread/compact/start"].includes(method),
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("Codex session generation is no longer current"),
    });
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
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: current.sessionId, updatedAt: 1 },
    });
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

    const pending = maybeCompactCodexAppServerSessionImpl(
      {
        sessionId: current.sessionId,
        sessionKey: current.sessionKey,
        agentId: current.agentId,
        sessionTarget: { ...scope, sessionId: current.sessionId },
        sessionFile: path.join(tempDir, "queued-authority.jsonl"),
        workspaceDir: tempDir,
        trigger: "manual",
      },
      { bindingStore, clientFactory },
    );
    try {
      await flushAsyncTasks();
      expect(clientFactory).not.toHaveBeenCalled();

      await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
    } finally {
      releaseQueue.resolve();
      await held;
    }

    await expect(pending).rejects.toThrow("Codex session generation is no longer current");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fake.request).not.toHaveBeenCalled();
    expect(bindingStore.read(current)).toEqual(binding);

    const adopted = await resolveCodexSessionBinding({
      bindingStore,
      identity: successor,
      storePath: scope.storePath,
    });
    expect(adopted.binding).toEqual(binding);
    expect(bindingStore.read(successor)).toEqual(binding);
  });

  it("explains manual subscription-sharing compaction without starting native inference", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir, {
      modelProvider: CODEX_RESPONSES_OAUTH_PROVIDER,
    });

    await expect(startCompaction(sessionFile)).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("Automatic compaction runs during normal turns"),
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("does not compact a thread created with restricted native authority", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir, {
      nativeToolPolicyRestricted: true,
    });

    await expect(startCompaction(sessionFile)).resolves.toMatchObject({
      ok: true,
      compacted: false,
      reason: "native compaction is unavailable for a host-isolated Codex session",
      result: {
        details: {
          backend: "codex-app-server",
          skipped: true,
          reason: "native_tool_policy_restricted",
          expectedThreadId: "thread-1",
        },
      },
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("does not compact an unrestricted binding during a host-isolated operation", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    await expect(
      startCompaction(sessionFile, { nativeToolSurface: "host-isolated" }),
    ).resolves.toMatchObject({
      ok: true,
      compacted: false,
      result: { details: { reason: "native_tool_policy_restricted" } },
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("keeps an owned thread subscribed when a sibling finishes during compaction", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const pending = startCompaction(sessionFile);
    await vi.waitFor(() => {
      expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions);
    });

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
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir, {
      clientId: "client-before-compaction",
    });
    const pending = startCompaction(sessionFile);
    await vi.waitFor(() => {
      expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions);
    });

    seedCodexTestBinding(sessionFile, {
      threadId: "thread-1",
      clientId: "client-after-compaction",
      cwd: tempDir,
    });
    fake.completeCompaction();

    await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    expect(fake.request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toEqual([
      [
        "thread/unsubscribe",
        { threadId: "thread-1" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      ],
    ]);
    await expect(consumeCodexAppServerLiveThread(fake.client, "thread-1")).resolves.toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      clientId: "client-after-compaction",
    });
  });

  it.each([
    // The incognito key is the path that actually matters: it keeps its own live
    // subscription, so compaction never claims and re-retains the thread.
    { label: "an edited catalog", refreshed: "catalog B", sessionKey: INCOGNITO_COMPACT_KEY },
    { label: "a withdrawn catalog", refreshed: undefined, sessionKey: "agent:main:session-1" },
  ])(
    "records $label as reverted after standalone compaction on $sessionKey",
    async ({ refreshed, sessionKey }) => {
      const fake = createFakeCodexClient();
      setCodexAppServerClientFactoryForTest(async () => fake.client);
      const sessionFile = await writeCompactionTestBinding(tempDir, {}, sessionKey);
      // The live thread was created with catalog A and refreshed in place, so
      // only the injected message carries the current catalog.
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
        maybeCompactCodexAppServerSession({
          sessionId: "session-1",
          sessionKey,
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
        }),
      ).resolves.toMatchObject({ ok: true, compacted: true });

      // Compaction discarded the injected refresh. Preserving the creation policy
      // keeps the live thread from reading as policy drift, and the reverted
      // catalog is what makes the next turn deliver the current one again.
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

  it("uses the exact prepared Platform key for native compaction", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn<CodexAppServerClientFactory>(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          provider: "openai",
          model: "gpt-5.5",
          resolvedApiKey: "prepared-platform-key",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.5",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        }),
        { clientFactory: factory },
      ),
    );

    expect(result.ok).toBe(true);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
        authRequirement: "api-key",
      }),
    );
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("authProfileId");
  });

  it("fails closed when prepared Platform compaction has no key", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          provider: "openai",
          model: "gpt-5.5",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.5",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        }),
        { clientFactory: factory },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Prepared Codex Platform compaction route is missing its resolved API key.",
    });
    expect(factory).not.toHaveBeenCalled();
  });

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
          runtimeAuthPlan: {
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
          },
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
      expect(fake.request.mock.calls.map(([method]) => method)).toEqual(
        supervised
          ? ["thread/resume", "thread/compact/start", "thread/unsubscribe"]
          : ["account/read"],
      );
    },
  );

  it("fails closed when a supervised binding is no longer enabled", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeSupervisedTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(compactionParams(sessionFile), {
        clientFactory: factory,
        pluginConfig: { supervision: { enabled: false } },
      }),
    );

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
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(
      new CodexAppServerRpcError(
        { code: -32_600, message: "compaction temporarily unavailable" },
        "thread/compact/start",
      ),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);
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

  it("preserves projection when aborted before guarded native compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const sessionFile = await writeTestBinding({
      contextEngine: contextEngineBinding(),
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          trigger: "budget",
          currentTokenCount: 456,
          abortSignal: abortController.signal,
        }),
        { allowNonManualNativeRequest: true },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server compaction aborted before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "aborted_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-1",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        projection: {
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
  });

  it("skips post-context-engine native compaction when the binding changes before projection clear", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const originalContextEngine = contextEngineBinding();
    const sessionFile = await writeTestBinding({
      contextEngine: originalContextEngine,
    });
    let bindingReads = 0;
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn((...args: Parameters<typeof testCodexAppServerBindingStore.read>) => {
        const result = testCodexAppServerBindingStore.read(...args);
        if (bindingReads++ === 0) {
          seedCodexTestBinding(sessionFile, {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              ...originalContextEngine,
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
      }),
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          trigger: "budget",
          currentTokenCount: 456,
        }),
        { allowNonManualNativeRequest: true, bindingStore },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server binding changed before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "binding_changed_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-2",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-2",
      contextEngine: {
        projection: {
          epoch: "epoch-2",
          fingerprint: "fingerprint-2",
        },
      },
    });
  });

  it("reports a recoverable stale-binding failure when a required-preflight native request sees the binding change", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const originalContextEngine = contextEngineBinding();
    const sessionFile = await writeTestBinding({
      contextEngine: originalContextEngine,
    });
    let bindingReads = 0;
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn((...args: Parameters<typeof testCodexAppServerBindingStore.read>) => {
        const result = testCodexAppServerBindingStore.read(...args);
        if (bindingReads++ === 0) {
          seedCodexTestBinding(sessionFile, {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              ...originalContextEngine,
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
      }),
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          trigger: "budget",
          preflightRequired: true,
          currentTokenCount: 456,
        }),
        {
          allowNonManualNativeRequest: true,
          nativeCompactionRequest: "required_preflight",
          bindingStore,
        },
      ),
    );

    // A required-preflight request has not compacted yet, so a binding change
    // must surface as the recoverable failure rather than a benign ok:true skip,
    // letting the queued harness fall back to the context engine.
    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server binding changed before native compaction");
    expect(result.failure?.reason).toBe("stale_thread_binding");
  });

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

      const result = requireCompactResult(
        await maybeCompactCodexAppServerSession(
          compactionParams(sessionFile, {
            trigger: "budget",
            currentTokenCount: 456,
          }),
          { allowNonManualNativeRequest: true },
        ),
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
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        compactionParams(sessionFile, {
          trigger: undefined,
          currentTokenCount: 789,
        }),
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server owns automatic compaction");
    expect(result.result?.tokensBefore).toBe(789);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "non_manual_trigger",
      trigger: "unknown",
    });
  });

  it("blocks native app-server compaction for configured and remote-exec sandboxes", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    for (const result of [
      requireCompactResult(
        await maybeCompactCodexAppServerSession(
          createSandboxedCompactionParams(tempDir, sessionFile),
        ),
      ),
      requireCompactResult(
        await maybeCompactCodexAppServerSession(
          createRemoteExecCompactionParams(tempDir, sessionFile),
        ),
      ),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
      expect(result.reason).toContain(
        "Codex-native native compaction is unavailable because OpenClaw sandboxing is active for this session.",
      );
    }
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("blocks native app-server compaction when exec host=node is active", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(createNodeExecCompactionParams(tempDir, sessionFile)),
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain(
      "Codex-native native compaction is unavailable because OpenClaw exec host=node is active for this session.",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it.each([["agent:beta:session-1", "beta", "global", "alpha"]] as const)(
    "uses the retained policy owner for explicit-roster compaction (%s)",
    async (sessionKey, agentId, sandboxSessionKey, sandboxAgentId) => {
      const fake = createFakeCodexClient();
      setCodexAppServerClientFactoryForTest(async () => fake.client);
      const sessionFile = await writeCompactionTestBinding(tempDir);

      const result = requireCompactResult(
        await maybeCompactCodexAppServerSession({
          sessionId: "session-1",
          sessionKey,
          sandboxSessionKey,
          sandboxAgentId,
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
          agentId,
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
      );

      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
      expect(result.reason).toContain(
        "Codex-native native compaction is unavailable because OpenClaw exec host=node is active for this session.",
      );
      expect(fake.request).not.toHaveBeenCalled();
    },
  );

  it("does not finish until the matching native compaction turn completes", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

    let settled = false;
    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions);
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { last: { totalTokens: 999 } },
      },
    });
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { last: { totalTokens: 321 } },
      },
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);
    emitTurn(fake, "turn-1", "completed");
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBe(321);
    expect(compactDetails(result).signal).toBe("thread/compact/start");
  });

  it("waits for completion after an already-terminal interrupt", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      interruptError: new CodexAppServerRpcError(
        { code: -32_600, message: "no active turn to interrupt" },
        "turn/interrupt",
      ),
    });
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const abortController = new AbortController();

    let settled = false;
    const pendingResult = maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, {
        abortSignal: abortController.signal,
      }),
      { clientFactory: async () => fake.client },
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    emitTurn(fake, "compact-turn-finished", "inProgress");
    for (const method of ["item/started", "item/completed"] as const) {
      fake.emit({
        method,
        params: {
          threadId: "thread-1",
          turnId: "compact-turn-finished",
          item: { id: "compact-item-finished", type: "contextCompaction" },
        },
      });
    }

    abortController.abort();
    let successorRan = false;
    const successor = withCodexAppServerThreadMutation("thread-1", async () => {
      successorRan = true;
    });
    try {
      await flushAsyncTasks();
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "compact-turn-finished" },
        { timeoutMs: 30_000 },
      );
      expect(settled).toBe(false);
      expect(successorRan).toBe(false);
    } finally {
      emitTurn(fake, "compact-turn-finished", "completed");
      await pendingResult;
      await successor;
    }

    await expect(pendingResult).resolves.toMatchObject({ ok: true, compacted: true });
    expect(fake.closeAndWait).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeDefined();
  });

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
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-configured",
        },
        { timeoutMs: 10 },
      );
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
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:recovered-retirement",
      sessionId: "after-compaction",
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const next = { ...current, sessionId: "next-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: previous.sessionId, updatedAt: 1 },
    });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "thread-1", cwd: tempDir };
    await bindingStore.mutate(previous, { kind: "set", binding });
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
    const pending = maybeCompactCodexAppServerSessionImpl(
      {
        sessionId: current.sessionId,
        sessionKey: current.sessionKey,
        agentId: current.agentId,
        sessionTarget: { ...scope, sessionId: current.sessionId },
        sessionFile: path.join(tempDir, "recovered.jsonl"),
        workspaceDir: tempDir,
        trigger: "manual",
      },
      {
        bindingStore,
        clientFactory: async () => fake.client,
        pluginConfig: {
          appServer: { transport: "websocket", url: "ws://127.0.0.1:45001" },
        },
        nativeCompletionTimeoutMs: 10,
        nativeInterruptGraceMs: 10,
      },
    ).finally(() => retirementOutcome.resolve("settled"));
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
    expect(recovered.binding).toEqual(binding);
    expect(bindingStore.read(next)).toEqual(binding);
  });

  it("cancels a native compaction after the start request", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const abortController = new AbortController();

    let settled = false;
    const pendingResult = maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, {
        abortSignal: abortController.signal,
      }),
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledOnce();
    });
    abortController.abort();
    await flushAsyncTasks();
    expect(settled).toBe(false);

    emitTurn(fake, "compact-turn-aborted", "inProgress");
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-aborted",
        },
        { timeoutMs: 30_000 },
      );
    });

    expect(settled).toBe(false);
    emitTurn(fake, "compact-turn-aborted", "interrupted");

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction turn ended with status interrupted",
    });
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
    const second = maybeCompactCodexAppServerSession({
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      sessionFile: secondSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      abortSignal: abortController.signal,
    });
    await flushAsyncTasks();
    expect(factory).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(second).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction aborted while waiting to start",
    });

    const third = maybeCompactCodexAppServerSession({
      sessionId: "session-3",
      sessionKey: "agent:main:session-3",
      sessionFile: thirdSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
    });
    await flushAsyncTasks();
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
    const sessionFile = await writeCompactionTestBinding(tempDir, {
      authProfileId: "openai:work",
      model: "gpt-5.5-mini",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: "priority",
    });

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions);
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-1");
    expect(preservedBinding?.authProfileId).toBe("openai:work");
    expect(preservedBinding?.model).toBe("gpt-5.5-mini");
    expect(preservedBinding?.approvalPolicy).toBe("on-request");
    expect(preservedBinding?.sandbox).toBe("workspace-write");
    expect(preservedBinding?.serviceTier).toBe("priority");
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("thread not found: thread-1");
    expect(result.failure?.reason).toBe("stale_thread_binding");
    expect(result.result).toBeUndefined();
    expect(fake.closeAndWait).not.toHaveBeenCalled();
  });

  it("detaches a guarded remote start after releasing the binding lock", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread/compact/start timed out"));
    fake.closeAndWait.mockResolvedValueOnce({ exited: false, cleanup: "uncertain" });
    const sessionFile = await writeCompactionTestBinding(tempDir);

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
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
      ),
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
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeCompactionTestBinding(tempDir);

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

    expectCompactStartRequest(fake.request, "thread-1", compactUnboundedRequestOptions);
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        ignoredConfig: [
          "agents.defaults.compaction.model",
          "agents.defaults.compaction.thinkingLevel",
          "agents.defaults.compaction.provider",
        ],
      },
    );
    warn.mockRestore();
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
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
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
      trigger: "manual",
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "missing_thread_binding" },
    });
    expect(compact).not.toHaveBeenCalled();
  });
});

function createFakeCodexClient(options?: Parameters<typeof createFakeCodexCompactionClient>[1]) {
  return createFakeCodexCompactionClient(tempDir, options);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
