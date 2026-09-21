import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams as createThreadLifecycleParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;

function threadStartResult(threadId = "thread-1") {
  return createThreadStartResult(threadId, tempDir);
}

function createThreadLifecycleAppServerOptions(): ReturnType<typeof createAppServerOptions> {
  return {
    ...createAppServerOptions(),
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

async function seedAdoptedThreadBinding(params: EmbeddedRunAttemptParams, cwd: string) {
  const threadId = "thread-adopted";
  const request = vi.fn(async (method: string) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start") {
      return threadStartResult(threadId);
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
  });
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const patched = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "patch",
    threadId,
    patch: {
      model: undefined,
      modelProvider: undefined,
      preserveNativeModel: true,
    },
  });
  if (!patched) {
    throw new Error("failed to seed adopted Codex thread binding");
  }
  return { identity, threadId };
}

describe("Codex app-server adopted thread lifecycle", () => {
  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-codex-thread-adoption-");
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it.each(["native-tools", "delegation"] as const)(
    "preserves expected native ownership instead of starting a fresh %s-restricted thread",
    async (restriction) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const nativeModel = threadStartResult(threadId);
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { model: nativeModel.model, modelProvider: nativeModel.modelProvider },
      });
      params.expectedSessionRuntimeOwnership = {
        model: "native",
        auth: "host",
        modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
      };
      if (restriction === "delegation") {
        params.delegationCapability = "report_only";
      }
      const before = testCodexAppServerBindingStore.read(identity);
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: [threadId],
        respond: (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      try {
        await expect(
          startOrResumeThread({
            client: fixture.client,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
            ...(restriction === "native-tools" ? { nativeCodeModeEnabled: false } : {}),
          }),
        ).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
      } finally {
        fixture.client.close();
      }
    },
  );

  it.each([false, true])(
    "preserves the cold native thread after host rotation with changed tools=%s",
    async (changedTools) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const storePath = path.join(tempDir, "sessions.json");
      params.config = { session: { store: storePath } };
      const scope = { agentId: "main", sessionKey: params.sessionKey!, storePath };
      await upsertSessionEntry({ ...scope, entry: { sessionId: params.sessionId, updatedAt: 1 } });
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const nativeModel = threadStartResult(threadId);
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { model: nativeModel.model, modelProvider: nativeModel.modelProvider },
      });
      params.expectedSessionRuntimeOwnership = {
        model: "native",
        auth: "host",
        modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
      };
      const before = testCodexAppServerBindingStore.read(identity);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "compacted-successor" }) });
      params.sessionId = "compacted-successor";
      const successor = { ...identity, sessionId: params.sessionId };
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: [threadId],
        respond: (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/resume") {
            return nativeModel;
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const resuming = startOrResumeThread({
        client: fixture.client,
        signal: new AbortController().signal,
        params,
        cwd: workspaceDir,
        dynamicTools: changedTools
          ? [{ type: "function", name: "new_tool", description: "New tool", inputSchema: {} }]
          : [],
        appServer: createThreadLifecycleAppServerOptions(),
      });
      if (changedTools) {
        await expect(resuming).rejects.toMatchObject({
          name: "AgentHarnessPreflightError",
          message: expect.stringContaining("changing the dynamic tool catalog"),
        });
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(
          false,
        );
        expect(testCodexAppServerBindingStore.read(successor)).toEqual(before);
      } else {
        await expect(resuming).resolves.toMatchObject({ threadId });
        expect(fixture.request.mock.calls.filter(([method]) => method === "thread/resume")).toEqual(
          [["thread/resume", expect.objectContaining({ threadId }), expect.anything()]],
        );
        expect(testCodexAppServerBindingStore.read(successor)).toMatchObject({
          threadId,
          preserveNativeModel: true,
        });
      }
      expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    },
  );

  it("keeps OpenClaw from overriding App Server model selection across resumes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
    let resumeCount = 0;
    const respond = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/resume") {
        resumeCount += 1;
        return {
          ...threadStartResult(threadId),
          model: `native-model-${resumeCount}`,
          modelProvider: resumeCount === 1 ? "lmstudio" : "ollama",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
      persistedThreads: [threadId],
    });
    const { client, request } = fixture;
    const commonParams = {
      client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };
    const firstBinding = await startOrResumeThread(commonParams);
    await fixture.endTurn(threadId);
    const secondBinding = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[8]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[9]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[9]?.[1]).not.toHaveProperty("modelProvider");
    expect(firstBinding).toMatchObject({
      model: "native-model-1",
      modelProvider: "lmstudio",
      preserveNativeModel: true,
    });
    expect(secondBinding).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });

    const persisted = testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });
  });

  it.each([
    { status: "active", canAcceptDirectInput: true, error: "active in another runner" },
    { status: "idle", canAcceptDirectInput: false, error: "controlled by its parent" },
    { status: "idle", canAcceptDirectInput: true, error: "native status read unavailable" },
  ])(
    "preserves retained adopted ownership when native preflight rejects: $error",
    async ({ status, canAcceptDirectInput, error }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(sessionFile, workspaceDir);
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      harness.seed(
        {
          ...threadStartResult(threadId),
          thread: {
            ...(threadStartResult(threadId).thread as object),
            status: { type: status },
            canAcceptDirectInput,
          },
        },
        { loaded: true, subscribed: true },
      );
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: workspaceDir });
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { clientId: harness.client.getInstanceId() },
      });
      if (error === "native status read unavailable") {
        const request = CodexAppServerClient.prototype.request.bind(harness.client);
        harness.request.mockImplementation((method, requestParams, options) => {
          if (method === "thread/read") {
            return Promise.reject(new Error(error));
          }
          return request(method, requestParams, options);
        });
      }
      const release = vi.fn();
      await retainCodexAppServerLiveThread(harness.client, threadId, release);
      const reserveResumeThread = vi.fn(() => ({ release: vi.fn() }));
      const before = testCodexAppServerBindingStore.read(identity);
      try {
        await expect(
          startOrResumeThread({
            client: harness.client,
            reserveResumeThread,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
          }),
        ).rejects.toThrow(error);

        expect(harness.request.mock.calls.map(([method]) => method)).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/read",
        ]);
        expect(release).not.toHaveBeenCalled();
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        expect(reserveResumeThread).not.toHaveBeenCalled();
        const retryOwnership = await consumeCodexAppServerLiveThread(harness.client, threadId);
        expect(retryOwnership).toBeDefined();
        expect(() => retryOwnership?.assertCurrent()).not.toThrow();
        await retryOwnership?.release(threadId);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        harness.client.close();
      }
    },
  );
});
