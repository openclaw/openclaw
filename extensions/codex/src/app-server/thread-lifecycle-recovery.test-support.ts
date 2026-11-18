import path from "node:path";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import {
  createAgentLifecycleHarness,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  type writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle-run.js";
import {
  createLeasedCodexLifecycleHarness,
  createLifecycleRequest,
  type CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";

export function registerThreadRecoveryBindingTests({
  createParams,
  createPaths,
  startOrResumeThread,
  writeCodexAppServerBinding,
}: {
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createPaths: () => { sessionFile: string; workspaceDir: string };
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeThreadImpl>;
  writeCodexAppServerBinding: typeof writeRawCodexAppServerBinding;
}) {
  it.each([
    "recover",
    "seed failure",
    "legacy",
    "wrong owner",
    "missing budget",
    "restricted policy",
  ] as const)("handles confirmed worker loss with %s", async (scenario) => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);
    let starts = 0;
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult(++starts === 1 ? "old-worker-thread" : "hydrated-thread");
        }
        if (method === "thread/delete") {
          return {};
        }
        if (method === "thread/resume") {
          if (scenario !== "recover") {
            throw new CodexAppServerRpcError(
              { code: -32603, message: "Synthetic lost native home" },
              method,
            );
          }
          return threadStartResult("hydrated-thread");
        }
        throw new Error("unexpected request " + method);
      },
    });
    const predecessor = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      environmentId: "old-worker",
      ownerEpoch: 7,
      retentionOwnerBinding: "a".repeat(64),
    };
    const common = {
      client: fixture.client,
      params,
      userMcpServersEnabled: false,
      retainedSession: true as const,
      nativeWorkerPlacement: { owner: predecessor },
    };
    const initial = await startOrResumeThread(common);
    await fixture.endTurn(initial.threadId);
    const before = await readCodexAppServerBinding(sessionFile);
    expect(before?.workerPlacementOwner).toEqual(predecessor);
    if (scenario === "restricted policy") {
      await writeCodexAppServerBinding(sessionFile, {
        ...before!,
        nativeToolPolicyRestricted: true,
      });
    }
    if (scenario === "legacy") {
      await writeCodexAppServerBinding(sessionFile, {
        ...before!,
        workerPlacementOwner: undefined,
      });
    }
    const nativeWorkerPlacement = {
      owner: { ...predecessor, environmentId: "new-worker", ownerEpoch: 11 },
      recovery: {
        version: 1 as const,
        predecessor: { ...predecessor, ...(scenario === "wrong owner" ? { ownerEpoch: 6 } : {}) },
      },
    };
    const history = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Quoted previous conversation, not a request" }],
      },
    ];
    fixture.request.mockClear();
    if (scenario === "seed failure") {
      const request = CodexAppServerClient.prototype.request.bind(fixture.client);
      fixture.request.mockImplementation(async (method, ...args) => {
        if (method === "thread/inject_items") {
          throw new Error("synthetic seed rejected");
        }
        return request(method, ...args);
      });
    }
    const result = startOrResumeThread({
      ...common,
      nativeWorkerPlacement,
      ...(scenario === "missing budget" ? {} : { historyBootstrapItems: history }),
    });
    if (scenario === "recover") {
      const recovered = await result;
      expect(recovered.threadId).toBe("hydrated-thread");
      const committed = await readCodexAppServerBinding(sessionFile);
      expect(committed).toMatchObject({
        workerPlacementOwner: nativeWorkerPlacement.owner,
        recoveredFrom: { owner: predecessor, threadId: "old-worker-thread" },
      });
      const methods = fixture.request.mock.calls.map(([method]) => method);
      expect(methods.indexOf("thread/start")).toBeLessThan(methods.indexOf("thread/inject_items"));
      expect(methods).not.toContain("turn/start");
      await fixture.endTurn(recovered.threadId);
      fixture.notify({ method: "thread/closed", params: { threadId: recovered.threadId } });
      fixture.request.mockClear();
      await startOrResumeThread({
        ...common,
        nativeWorkerPlacement,
        historyBootstrapItems: history,
      });
      expect(fixture.request.mock.calls.map(([method]) => method)).not.toContain("thread/start");
      const appended = fixture.request.mock.calls.filter(
        ([method]) => method === "thread/inject_items",
      );
      expect(JSON.stringify(appended)).not.toContain("Quoted previous conversation, not a request");
    } else {
      await expect(result).rejects.toThrow(
        scenario === "seed failure"
          ? "synthetic seed rejected"
          : scenario === "missing budget"
            ? "canonical bounded available history"
            : "no input was submitted and a fresh thread is refused",
      );
      expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("old-worker-thread");
      expect(fixture.request.mock.calls.map(([method]) => method)).not.toContain("turn/start");
    }
  });
}

/** Keep recovered-generation races beside the native recovery binding fixtures. */
export function registerRecoveredGenerationBindingTest({
  createParams,
  createThreadLifecycleAppServerOptions,
  webSearchFingerprint,
}: {
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createThreadLifecycleAppServerOptions: () => LifecycleInput["appServer"];
  webSearchFingerprint: string;
}) {
  it("rejects a host-only rotation after recovering the predecessor before the lifecycle lease", async () => {
    const workspaceDir = path.join(tempDir, "recovered-workspace");
    const params = createParams(path.join(tempDir, "recovered.jsonl"), workspaceDir);
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: params.sessionKey!,
      sessionId: params.sessionId,
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    params.sessionTarget = { ...scope, sessionId: current.sessionId };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const native = threadStartResult("recovered-native-thread");
    const fixture = await createAgentLifecycleHarness({
      respond: createLifecycleRequest(async (method) => {
        if (method === "thread/resume") {
          return native;
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    });
    fixture.seed(native, { loaded: true, subscribed: false });
    const bindingStore = createCodexTestBindingStore();
    const binding = {
      threadId: native.thread.id,
      cwd: workspaceDir,
      preserveNativeModel: true as const,
      model: native.model,
      modelProvider: native.modelProvider,
      webSearchThreadConfigFingerprint: webSearchFingerprint,
    };
    await bindingStore.mutate(previous, { kind: "set", binding });
    const withLease = bindingStore.withLease.bind(bindingStore);
    vi.spyOn(bindingStore, "withLease").mockImplementationOnce(async (identity, run) => {
      expect(bindingStore.read(current)).toEqual(binding);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
      return withLease(identity, run);
    });

    await expect(
      startOrResumeThreadImpl({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
        bindingStore,
      }),
    ).rejects.toThrow("Codex session generation is no longer current");
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(bindingStore.read(current)).toEqual(binding);
  });
}
