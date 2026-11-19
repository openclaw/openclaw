import assert from "node:assert/strict";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { RetainedLiveThread } from "./client-thread-owner.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import type { JsonObject, RpcRequest } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { retireSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
import { stubCodexInferenceTransportEnv, useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetThreadLifecycleTestFixtures);

async function fixture(
  withProjection = false,
  pluginFingerprint?: () => string,
  inferenceConfig?: JsonObject,
) {
  if (inferenceConfig) {
    stubCodexInferenceTransportEnv();
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
  }
  const cwd = tempDirs.make("codex-assignment-rotation-");
  const params = createParams(path.join(cwd, "session.jsonl"), cwd);
  params.disableTools = false;
  params.agentId = "main";
  if (withProjection) {
    params.contextEngine = {
      info: { id: "test", name: "Test", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
  }
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  const key = bindingStoreKey(identity);
  const values = new Map<string, StoredCodexAppServerBinding>();
  const store = createCodexAppServerBindingStore(createCodexTestBindingStateStore(values));
  let starts = 0;
  let successor: (() => Promise<ReturnType<typeof threadStartResult>>) | undefined;
  const wire = await createLeasedCodexLifecycleHarness({
    agentDir: cwd,
    respond: async (method) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/start") {
        starts += 1;
        return starts > 1 && successor ? await successor() : threadStartResult(`parent-${starts}`);
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`Unexpected native lifecycle request: ${method}`);
    },
  });
  if (inferenceConfig) {
    ownCodexInferenceClient(wire.client);
  }
  const options = {
    ...(inferenceConfig ? { config: inferenceConfig } : {}),
    client: wire.client,
    bindingStore: store,
    params,
    cwd,
    dynamicTools: [],
    appServer: createAppServerOptions(),
    nativeCodeModeEnabled: true,
    userMcpServersEnabled: false,
    ...(withProjection
      ? {
          contextEngineProjection: {
            mode: "thread_bootstrap" as const,
            epoch: "before",
            fingerprint: "before",
          },
        }
      : {}),
    ...(pluginFingerprint
      ? {
          pluginThreadConfig: {
            enabled: true,
            requiresCurrentPolicyCheck: true,
            inputFingerprint: "stable-input",
            build: async () => ({
              enabled: true,
              fingerprint: pluginFingerprint(),
              inputFingerprint: "stable-input",
              configPatch: {},
              diagnostics: [],
              policyContext: { fingerprint: "empty", apps: {}, pluginAppIds: {} },
            }),
          },
        }
      : {}),
    mcpServersFingerprint: "mcp-before",
    mcpServersFingerprintEvaluated: true,
    appServerRuntimeFingerprint: "connection-A",
  } satisfies CodexStartOrResumeThreadParams;
  const parent = await startOrResumeThread(options);
  if (inferenceConfig) {
    const route = getCodexInferenceThread(wire.client, parent.threadId);
    assert(route);
    onTestFinished(() => route.close());
  }
  const releasePredecessor = vi.fn<RetainedLiveThread["release"]>(
    async (threadId, assertCurrent, withCurrent) => {
      await wire.client.request("thread/unsubscribe", { threadId }, { assertCurrent, withCurrent });
    },
  );
  await retainCodexAppServerLiveThread(
    wire.client,
    parent.threadId,
    releasePredecessor,
    parent.liveThreadConfigFingerprint,
  );
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: parent.threadId,
    sessionId: params.sessionId,
    binding: parent,
  });
  assert(owner);
  const assignments: CodexNativeSubagentPendingAssignment[] = [
    {
      runId: "codex-thread:running-child",
      childThreadId: "running-child",
      nativeParentThreadId: parent.threadId,
      owner,
    },
    {
      runId: "codex-thread:finished-child",
      childThreadId: "finished-child",
      nativeParentThreadId: parent.threadId,
      owner,
      recordedCompletion: {
        childThreadId: "finished-child",
        status: "succeeded",
        statusLabel: "recorded_task_result",
        result: "Retained child result",
        completedAt: 200,
      },
    },
  ];
  const stored = values.get(key);
  assert(stored?.state === "active");
  values.set(key, {
    ...stored,
    nativeSubagentAssignments: { version: 1, assignments },
    nativeSubagentTaskImport: { version: 1, taskIds: ["legacy-running", "legacy-finished"] },
  });
  const readAssignments = (threadId: string, binding = parent) => {
    const currentOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: threadId,
      sessionId: params.sessionId,
      binding,
    });
    assert(currentOwner);
    assert(typeof store.readNativeSubagentAssignments === "function");
    return store.readNativeSubagentAssignments(identity, currentOwner);
  };
  const readState = () => {
    const current = values.get(key);
    if (!current) {
      return undefined;
    }
    const { lease: _lease, ...durable } = current;
    return structuredClone(durable);
  };
  expect(await readAssignments(parent.threadId)).toEqual(assignments);
  return {
    ...wire,
    options,
    identity,
    readState,
    store,
    parent,
    assignments,
    releasePredecessor,
    readAssignments,
    setSuccessor: (respond: () => Promise<ReturnType<typeof threadStartResult>>) => {
      successor = respond;
    },
    rotate: (patch: Partial<CodexStartOrResumeThreadParams> = {}) =>
      startOrResumeThread({ ...options, mcpServersFingerprint: "mcp-after", ...patch }),
  };
}

describe("native assignment custody across ordinary parent rotation", () => {
  it("keeps imported assignments until the ordinary replacement commits", async () => {
    const f = await fixture();
    const before = f.readState();
    const entered = createDeferred<void>();
    const proceed = createDeferred<void>();
    f.setSuccessor(async () => {
      entered.resolve();
      await proceed.promise;
      return threadStartResult("parent-2");
    });
    const pending = f.rotate();
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        settled.then(() => {
          throw new Error("Replacement settled before reaching native thread/start");
        }),
      ]);
      expect(f.readState()).toEqual(before);
      expect(await f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
      expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
        f.parent.threadId,
        undefined,
        expect.any(Function),
      );
    } finally {
      proceed.resolve();
      await settled;
    }
    const replacement = await pending;
    expect(f.store.read(f.identity)?.threadId).toBe("parent-2");
    expect(await f.readAssignments(replacement.threadId, replacement)).toEqual(f.assignments);
  });

  it("does not expose the old assignments through a different connection", async () => {
    const f = await fixture();
    const replacement = await f.rotate({ appServerRuntimeFingerprint: "connection-B" });
    expect(replacement.appServerRuntimeFingerprint).toBe("connection-B");
    expect(await f.readAssignments(replacement.threadId, replacement)).toEqual([]);
  });

  it.each(["start", "revoked", "conflict"] as const)(
    "preserves authoritative assignments when the successor encounters %s failure",
    async (failure) => {
      const f = await fixture();
      let expected = f.readState();
      assert(expected?.state === "active");
      const predecessor = expected.binding;
      const closeHost =
        failure === "revoked"
          ? await bindProductionHarnessHostCapabilitiesForTest(f.options.params, {
              profileId: "rotation-operator",
              scopes: ["operator.write"],
              assertCurrent: () => {},
            })
          : undefined;
      if (closeHost) {
        onTestFinished(closeHost);
      }
      f.setSuccessor(async () => {
        if (failure === "start") {
          throw new Error("Successor start rejected");
        }
        if (failure === "revoked") {
          closeHost?.();
        }
        if (failure === "conflict") {
          expect(
            await f.store.mutate(f.identity, {
              kind: "replace-thread",
              expectedThreadId: f.parent.threadId,
              binding: { ...predecessor, threadId: "competing-parent" },
            }),
          ).toBe(true);
          expected = f.readState();
        }
        return threadStartResult("parent-uncommitted");
      });
      await expect(f.rotate()).rejects.toThrow(
        {
          start: "Successor start rejected",
          revoked: "agent harness host capability is no longer active",
          conflict: "Codex thread binding changed while committing a fresh thread: parent-1",
        }[failure],
      );
      expect(f.readState()).toEqual(expected);
      assert(expected?.state === "active");
      expect(await f.readAssignments(expected.binding.threadId)).toEqual(f.assignments);
      expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(2);
      expect(
        f.request.mock.calls
          .filter(([method]) => method === "thread/delete")
          .map(([, params]) => params),
      ).toEqual(failure === "start" ? [] : [{ threadId: "parent-uncommitted" }]);
      expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
        f.parent.threadId,
        undefined,
        expect.any(Function),
      );
    },
  );

  it("refuses a predecessor unsubscribe revoked immediately before its wire admission", async () => {
    const f = await fixture();
    const before = f.readState();
    const controller = new AbortController();
    const release = f.releasePredecessor.getMockImplementation();
    assert(release);
    f.releasePredecessor.mockImplementationOnce(async (...args) => {
      controller.abort(new Error("Rotation revoked before unsubscribe"));
      await release(...args);
    });

    await expect(f.rotate({ signal: controller.signal })).rejects.toThrow();

    expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
      f.parent.threadId,
      undefined,
      expect.any(Function),
    );
    expect(f.request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toEqual([
      [
        "thread/unsubscribe",
        { threadId: f.parent.threadId },
        { assertCurrent: undefined, withCurrent: expect.any(Function) },
      ],
    ]);
    const methods = f.writes.map((line) => (JSON.parse(line) as RpcRequest).method);
    expect(methods.filter((method) => method === "thread/unsubscribe")).toEqual([]);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(f.readState()).toEqual(before);
    expect(await f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
  });

  it("refreshes context while background cleanup retains the predecessor", async () => {
    const f = await fixture(true);
    const debug = vi.spyOn(embeddedAgentLog, "debug").mockImplementation(() => {});
    onTestFinished(() => debug.mockRestore());
    const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
    assert(claim);
    const releaseProtection = protectCodexAppServerLiveThread(f.client, f.parent.threadId);
    await claim.release(f.parent.threadId);
    try {
      const next = await f.rotate({
        mcpServersFingerprint: "mcp-before",
        contextEngineProjection: { mode: "thread_bootstrap", epoch: "after", fingerprint: "after" },
      });
      expect(next.threadId).toBe("parent-2");
      const stored = f.readState();
      assert(stored?.state === "active");
      expect(stored.binding.threadId).toBe(next.threadId);
      expect(next.contextEngine?.projection?.epoch).toBe("after");
      expect(debug).toHaveBeenCalledWith(
        "codex app-server context-engine binding changed; starting a new thread",
        expect.objectContaining({ backgroundRetentionReason: "retained" }),
      );
      expect(f.releasePredecessor).not.toHaveBeenCalled();
      expect(await f.readAssignments(next.threadId)).toEqual(f.assignments);
    } finally {
      releaseProtection();
    }
    await vi.waitFor(() => expect(f.releasePredecessor).toHaveBeenCalledTimes(1));
  });

  it.each([
    "client-mismatch",
    "engine-policy-mismatch",
    "tool-mismatch",
    "not-background-only",
    "plugin-policy-mismatch",
    "immutable-config-mismatch",
  ] as const)(
    "explains %s without releasing protected work or changing the binding",
    async (reason) => {
      let pluginFingerprint = "original-policy";
      const f = await fixture(
        true,
        reason === "plugin-policy-mismatch" ? () => pluginFingerprint : undefined,
      );
      const before = f.readState();
      const debug = vi.spyOn(embeddedAgentLog, "debug").mockImplementation(() => {});
      onTestFinished(() => debug.mockRestore());
      const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
      assert(claim);
      const releaseProtection = protectCodexAppServerLiveThread(f.client, f.parent.threadId);
      if (reason !== "not-background-only") {
        await claim.release(f.parent.threadId);
      }
      const patch: Partial<CodexStartOrResumeThreadParams> = {
        mcpServersFingerprint: "mcp-before",
        contextEngineProjection: { mode: "thread_bootstrap", epoch: "after", fingerprint: "after" },
      };
      if (reason === "client-mismatch") {
        retireSharedCodexAppServerClientIfCurrent(f.client);
        const replacement = await createLeasedCodexLifecycleHarness({
          agentDir: f.options.cwd,
          respond: (method) => {
            if (method === "config/read") {
              return { config: {}, origins: {}, layers: [] };
            }
            if (method === "configRequirements/read") {
              return { requirements: null };
            }
            throw new Error("Unexpected replacement request: " + method);
          },
        });
        expect(replacement.client.getInstanceId()).not.toBe(f.client.getInstanceId());
        patch.client = replacement.client;
      } else if (reason === "engine-policy-mismatch") {
        patch.params = { ...f.options.params, contextTokenBudget: 12_345 };
      } else if (reason === "tool-mismatch") {
        patch.dynamicTools = [
          {
            type: "function",
            name: "changed_tool",
            description: "Changed tool",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      } else if (reason === "plugin-policy-mismatch") {
        pluginFingerprint = "changed-policy";
      } else if (reason === "immutable-config-mismatch") {
        patch.developerInstructions = "Private policy sentinel: never include in diagnostics";
      }
      try {
        await expect(f.rotate(patch)).rejects.toThrow("claimed by active work; stop it first");
        expect(f.readState()).toEqual(before);
        expect(f.releasePredecessor).not.toHaveBeenCalled();
        expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
          1,
        );
        expect(debug).toHaveBeenCalledWith(
          "codex app-server context-engine binding changed; starting a new thread",
          expect.objectContaining({ backgroundRetentionReason: reason }),
        );
        expect(debug).toHaveBeenCalledWith("codex app-server retained thread release blocked", {
          threadId: f.parent.threadId,
          changedClient: reason === "client-mismatch",
          claimed: true,
          protected: true,
          backgroundOnly: reason !== "not-background-only",
        });
        const diagnostic = debug.mock.calls.find(
          ([message]) =>
            message === "codex app-server context-engine binding changed; starting a new thread",
        );
        expect(JSON.stringify(diagnostic)).not.toContain("Private policy sentinel");
      } finally {
        releaseProtection();
        await claim.release(f.parent.threadId);
      }
    },
  );

  it("refreshes an owned inference projection without releasing its background predecessor", async () => {
    const f = await fixture(true, undefined, { openai_base_url: "https://api.example.com/v1" });
    const route = getCodexInferenceThread(f.client, f.parent.threadId);
    assert(route);
    const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
    assert(claim);
    const releaseProtection = protectCodexAppServerLiveThread(f.client, f.parent.threadId);
    await claim.release(f.parent.threadId);
    try {
      const next = await f.rotate({
        mcpServersFingerprint: "mcp-before",
        contextEngineProjection: { mode: "thread_bootstrap", epoch: "after", fingerprint: "after" },
      });
      expect(next.threadId).toBe("parent-2");
      expect(f.store.read(f.identity)?.threadId).toBe(next.threadId);
      expect(next.contextEngine?.projection?.epoch).toBe("after");
      expect(getCodexInferenceThread(f.client, next.threadId)).toBe(route);
      expect(f.releasePredecessor).not.toHaveBeenCalled();
      expect(await f.readAssignments(next.threadId, next)).toEqual(f.assignments);
    } finally {
      releaseProtection();
    }
    await vi.waitFor(() => expect(f.releasePredecessor).toHaveBeenCalledTimes(1));
  });

  it.each([
    "upstream",
    "auth profile",
    "persistent instructions",
    "permission policy",
    "other config",
    "foreground",
  ] as const)(
    "keeps owned inference background custody when %s disallows projection retention",
    async (changed) => {
      const config = { openai_base_url: "https://api.example.com/v1" };
      const f = await fixture(true, undefined, config);
      const before = f.readState();
      const route = getCodexInferenceThread(f.client, f.parent.threadId);
      assert(route);
      const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
      assert(claim);
      const releaseProtection = protectCodexAppServerLiveThread(f.client, f.parent.threadId);
      if (changed !== "foreground") {
        await claim.release(f.parent.threadId);
      }
      const patch: Partial<CodexStartOrResumeThreadParams> = {
        mcpServersFingerprint: "mcp-before",
        contextEngineProjection: { mode: "thread_bootstrap", epoch: "after", fingerprint: "after" },
      };
      if (changed === "upstream") {
        patch.config = { ...config, openai_base_url: "https://other.example.com/v1" };
      } else if (changed === "auth profile") {
        patch.params = {
          ...f.options.params,
          authProfileId: "openai:work",
          authProfileStore: {
            version: 1,
            profiles: {
              "openai:work": { type: "api_key", provider: "openai", key: "synthetic-work-key" },
            },
          },
        };
      } else if (changed === "persistent instructions") {
        patch.developerInstructions = "Changed persistent policy";
      } else if (changed === "permission policy") {
        patch.config = { ...config, sandbox_mode: "read-only" };
      } else if (changed === "other config") {
        patch.config = { ...config, model_context_window: 100_000 };
      }
      try {
        await expect(f.rotate(patch)).rejects.toThrow("claimed by active work; stop it first");
        expect(f.readState()).toEqual(before);
        expect(getCodexInferenceThread(f.client, f.parent.threadId)).toBe(route);
        expect(f.releasePredecessor).not.toHaveBeenCalled();
        expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
          1,
        );
        expect(await f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
      } finally {
        releaseProtection();
        await claim.release(f.parent.threadId);
      }
    },
  );

  it("refuses a claimed predecessor before starting or committing a successor", async () => {
    const f = await fixture();
    const before = f.readState();
    const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
    assert(claim);
    try {
      await expect(f.rotate()).rejects.toThrow("claimed by active work; stop it first");
      expect(f.readState()).toEqual(before);
      expect(await f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
      expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
      expect(f.releasePredecessor).not.toHaveBeenCalled();
      expect(() => claim.assertCurrent()).not.toThrow();
    } finally {
      await claim.release(f.parent.threadId);
    }
  });
});
