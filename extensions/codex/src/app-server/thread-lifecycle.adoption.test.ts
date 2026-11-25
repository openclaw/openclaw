import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
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
  readEmptyNativeConfig,
  resetThreadLifecycleTestFixtures,
  startOrResumeThreadWithoutSkills as startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-thread-adoption-");
let tempDir: string;

function threadStartResult(threadId = "thread-1") {
  return createThreadStartResult(threadId, tempDir);
}

function createThreadLifecycleAppServerOptions(): ReturnType<typeof createAppServerOptions> {
  return {
    ...createAppServerOptions(),
    connectionClass: "local-loopback",
  };
}

async function seedAdoptedThreadBinding(
  params: EmbeddedRunAttemptParams,
  cwd: string,
  appServer = createThreadLifecycleAppServerOptions(),
) {
  const threadId = "thread-adopted";
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") {
      return threadStartResult(threadId);
    }
    return readEmptyNativeConfig(method);
  });
  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd,
    dynamicTools: [],
    appServer,
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
    tempDir = tempDirs.make();
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it.each(["native-tools", "delegation", "host-only-delegation", "runtime identity"] as const)(
    "preserves expected native ownership when %s would replace its thread",
    async (restriction) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const nativeModel = threadStartResult(threadId);
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: {
          model: nativeModel.model,
          modelProvider: nativeModel.modelProvider,
          ...(restriction === "runtime identity" ? { appServerRuntimeFingerprint: "before" } : {}),
        },
      });
      params.expectedSessionRuntimeOwnership = {
        model: "native",
        auth: "host",
        modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
      };
      if (restriction === "delegation" || restriction === "host-only-delegation") {
        params.delegationCapability = restriction === "delegation" ? "report_only" : "host_only";
      } else if (restriction === "native-tools") {
        params.disableTools = true;
      }
      const before = testCodexAppServerBindingStore.read(identity);
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: [threadId],
        respond: readEmptyNativeConfig,
      });
      try {
        await expect(
          startOrResumeThread({
            client: fixture.client,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
            ...(restriction === "runtime identity" ? { appServerRuntimeFingerprint: "after" } : {}),
            ...(restriction === "native-tools" ? { nativeCodeModeEnabled: false } : {}),
          }),
        ).rejects.toMatchObject({
          name: "AgentHarnessPreflightError",
          ...(restriction === "runtime identity"
            ? { message: expect.stringContaining("changing runtime identity") }
            : {}),
        });
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
      } finally {
        fixture.client.close();
      }
    },
  );

  it("preserves the cold native thread after host rotation with changed tools", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
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
        if (method === "thread/resume") {
          return nativeModel;
        }
        return readEmptyNativeConfig(method);
      },
    });
    const resuming = startOrResumeThread({
      client: fixture.client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        { type: "function", name: "new_tool", description: "New tool", inputSchema: {} },
      ],
      appServer: createThreadLifecycleAppServerOptions(),
    });
    await expect(resuming).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message: expect.stringContaining("changing the dynamic tool catalog"),
    });
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(testCodexAppServerBindingStore.read(successor)).toEqual(before);
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
  });

  it.each([
    { status: "active", canAcceptDirectInput: true, error: "active in another runner" },
    { status: "idle", canAcceptDirectInput: false, error: "controlled by its parent" },
  ])(
    "preserves retained adopted ownership when native preflight rejects: $error",
    async ({ status, canAcceptDirectInput, error }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(sessionFile, workspaceDir);
      params.disableTools = false;
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: readEmptyNativeConfig,
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

  it.each(["completed", "cancelled", "revoked"] as const)(
    "waits without interrupting a remote turn that survived the Gateway restart: %s",
    async (outcome) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.inputProvenance = { kind: "internal_system", sourceTool: "restart" };
      params.disableTools = false;
      const local = createThreadLifecycleAppServerOptions();
      const appServer = {
        ...local,
        start: { ...local.start, transport: "websocket" as const, url: "ws://127.0.0.1:47123" },
      };
      const { identity, threadId } = await seedAdoptedThreadBinding(
        params,
        workspaceDir,
        appServer,
      );
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: (method) =>
          method === "thread/resume" ? threadStartResult(threadId) : readEmptyNativeConfig(method),
        unsubscribe: () => ({ status: "notLoaded" }),
      });
      const seeded = threadStartResult(threadId);
      harness.seed(
        {
          ...seeded,
          thread: { ...(seeded.thread as object), status: { type: "active" } },
        },
        { loaded: true, subscribed: false },
      );
      const before = testCodexAppServerBindingStore.read(identity);
      const controller = new AbortController();
      let revoked = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const resuming = startOrResumeThread({
        client: harness.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
        signal: controller.signal,
        assertCurrent: () => {
          if (revoked) {
            throw new Error("restart authority revoked");
          }
        },
      });
      void resuming.catch(() => {});
      const methods = () => harness.request.mock.calls.map(([method]) => method);
      const sentReads = () =>
        harness.writes.filter((line) => JSON.parse(line).method === "thread/read").length;
      try {
        await harness.waitForMethod("thread/read");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        // The active turn is only observed: no subscription change, interrupt or new input.
        expect(methods()).toEqual(["config/read", "configRequirements/read", "thread/read"]);
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        if (outcome === "completed") {
          harness.notify({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: "turn-before-restart", status: "completed", items: [] },
            },
          });
          await vi.advanceTimersByTimeAsync(1_000);
          vi.useRealTimers();
          const resumed = await resuming;
          expect(resumed.threadId).toBe(threadId);
          expect(resumed.lifecycle.action).toBe("resumed");
          expect(sentReads()).toBe(2);
        } else {
          if (outcome === "cancelled") {
            // A Gateway shutdown aborts the run; the wait ends without another poll.
            controller.abort(new Error("Gateway shutting down"));
          } else {
            revoked = true;
            await vi.advanceTimersByTimeAsync(1_000);
          }
          await expect(resuming).rejects.toThrow(
            outcome === "cancelled" ? "Gateway shutting down" : "restart authority revoked",
          );
          expect(sentReads()).toBe(1);
          expect(methods()).not.toContain("thread/resume");
          expect(methods()).not.toContain("thread/unsubscribe");
          expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        }
        expect(methods()).not.toContain("turn/interrupt");
        expect(methods()).not.toContain("turn/start");
        expect(methods()).not.toContain("thread/start");
      } finally {
        controller.abort();
        await Promise.allSettled([resuming]);
        harness.client.close();
      }
    },
  );
});
