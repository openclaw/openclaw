import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  drainSessionDiskBudgetWorkers,
  getTrackedWorkerLifecycleSnapshot,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAppServerHarness,
  createStartedThreadHarness,
  createParams,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const DISABLED_WEB_SEARCH_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

async function writeExistingReasoningBinding(
  sessionFile: string,
  workspaceDir: string,
  reasoningEffort: string | null,
) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    historyCoveredThrough: new Date().toISOString(),
    webSearchThreadConfigFingerprint: DISABLED_WEB_SEARCH_FINGERPRINT,
    dynamicToolsFingerprint: "[]",
    reasoningEffort,
  });
}

beforeAll(() => {
  const startedBefore = getTrackedWorkerLifecycleSnapshot().workerLifecycle.reduce(
    (total, worker) => total + worker.started,
    0,
  );
  // The scan pool is shared across cases; verify its file owner after all fixture cleanup.
  return async () => {
    try {
      await setImmediate();
      // Unlike process.on("worker"), this includes children of the retained-worker supervisor.
      const { workerLifecycle } = getTrackedWorkerLifecycleSnapshot();
      expect(workerLifecycle.reduce((total, worker) => total + worker.started, 0)).toBeGreaterThan(
        startedBefore,
      );
      const liveWorkers = workerLifecycle.filter(({ script, started, retired }) => {
        // The default native supervisor belongs to the process; its children belong to the fixture.
        if (script === "worker-native-lifecycle.worker.js") {
          return false;
        }
        return started !== retired.reduce((total, retirement) => total + retirement.count, 0);
      });
      expect(
        liveWorkers,
        `Worker threads surviving Codex fixture teardown: ${JSON.stringify(liveWorkers)}`,
      ).toEqual([]);
    } finally {
      await drainSessionDiskBudgetWorkers();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
  };
});

setupRunAttemptTestHooks();

describe("Codex reasoning effort across completed turns", () => {
  it("changes high to off on the same Platform thread", async () => {
    let turnCount = 0;
    let turnStarted = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        const result = turnStartResult(`turn-${++turnCount}`);
        turnStarted.resolve();
        return result;
      }
      return undefined;
    });
    const params = createTestParams();
    const compat: ModelCompatConfig = {
      supportsTools: false,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    params.provider = "openai";
    params.modelId = "gpt-5.6-luna";
    params.model = {
      ...params.model,
      provider: "openai",
      id: params.modelId,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compat,
    };
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;

    for (const [index, thinkLevel] of (["high", "off"] as const).entries()) {
      turnStarted = createDeferred<void>();
      const run = runCodexAppServerAttempt({
        ...params,
        thinkLevel,
        runId: `run-${index + 1}`,
      });
      await Promise.race([turnStarted.promise, run]);
      expect(turnCount).toBe(index + 1);
      await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${index + 1}` });
      await run;
    }

    expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    const turnRequests = harness.requests.filter(({ method }) => method === "turn/start");
    expect(turnRequests.map(({ params: request }) => request)).toMatchObject([
      {
        threadId: "thread-1",
        effort: "high",
        collaborationMode: { settings: { reasoning_effort: "high" } },
      },
      {
        threadId: "thread-1",
        effort: null,
        collaborationMode: { settings: { reasoning_effort: null } },
      },
    ]);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.lifecycle",
      data: expect.objectContaining({ phase: "turn_starting", effort: "high" }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.lifecycle",
      data: expect.objectContaining({ phase: "turn_starting", effort: null }),
    });
  });

  it("patches a legacy binding when native reasoning changes before turn/start returns", async () => {
    const params = createTestParams();
    await writeCodexAppServerBinding(params.sessionFile, {
      threadId: "thread-existing",
      cwd: params.workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      historyCoveredThrough: new Date().toISOString(),
      webSearchThreadConfigFingerprint: DISABLED_WEB_SEARCH_FINGERPRINT,
      dynamicToolsFingerprint: "[]",
    });
    expect(await readCodexAppServerBinding(params.sessionFile)).not.toHaveProperty(
      "reasoningEffort",
    );
    const harness: ReturnType<typeof createAppServerHarness> = createAppServerHarness(
      async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "thread/resume") {
          return { ...threadStartResult("thread-existing"), reasoningEffort: "low" };
        }
        if (method === "turn/start") {
          await harness.notify({
            method: "thread/settings/updated",
            params: {
              threadId: "thread-existing",
              threadSettings: { effort: "high" },
            },
          });
          await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
          return turnStartResult("turn-1", "completed");
        }
        return {};
      },
      { persistedThreads: ["thread-existing"] },
    );
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;

    await runCodexAppServerAttempt(params);

    await expect(readCodexAppServerBinding(params.sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      webSearchThreadConfigFingerprint: DISABLED_WEB_SEARCH_FINGERPRINT,
      reasoningEffort: "high",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.lifecycle",
      data: expect.objectContaining({ phase: "turn_starting", effort: "medium" }),
    });
  });

  it("rejects a pre-turn reasoning update after durable ownership changes", async () => {
    const params = createTestParams();
    await writeExistingReasoningBinding(params.sessionFile, params.workspaceDir, null);
    const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
    const bindingStore: typeof testCodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (identity, mutation) =>
        mutation.kind === "patch" && mutation.patch.reasoningEffort === "high"
          ? false
          : await mutate(identity, mutation),
    };
    const harness: ReturnType<typeof createAppServerHarness> = createAppServerHarness(
      async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          await harness.notify({
            method: "thread/settings/updated",
            params: {
              threadId: "thread-existing",
              threadSettings: { effort: "high" },
            },
          });
          await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
          return turnStartResult("turn-1", "completed");
        }
        return {};
      },
      { persistedThreads: ["thread-existing"] },
    );

    await runCodexAppServerAttempt(createParams(params.sessionFile, params.workspaceDir), {
      bindingStore,
    });

    await expect(readCodexAppServerBinding(params.sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      reasoningEffort: null,
    });
  });
});
