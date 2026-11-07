import assert from "node:assert/strict";
import { createOpenClawCodingToolsAsync } from "openclaw/plugin-sdk/agent-harness";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  getSessionEntryAsync,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import {
  createCodexInferenceDispatch,
  createCodexInferenceModelBinding,
} from "./inference-dispatch.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { buildCodexNativeHookRelayId } from "./native-hook-relay.js";
import {
  CodexNativeProcessAuthority,
  getCodexNativeProcessClient,
} from "./native-process-authority.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { isJsonObject, type CodexThreadGoal, type JsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  type createStartedThreadHarness,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createNativeGoalFixture as fixture } from "./run-attempt.native-goal.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  getSharedCodexAppServerClientState,
  retainSharedCodexAppServerClientByInstanceId,
} from "./shared-client-lifecycle.js";
import * as transport from "./transport.js";

setupRunAttemptTestHooks();

it.each([false, true])(
  "keeps native successors under the same run (managed tool restriction: %s)",
  async (restricted) => {
    const f = fixture();
    f.params.pluginHarnessToolPolicyRestricted = restricted;
    const run = f.run();
    try {
      await f.started(run);
      await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await f.harness.notify({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
      });
      await f.harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          itemId: "answer",
          delta: "Native successor answer",
        },
      });
      // The verdict can arrive before the successor is bound: its accepted turn
      // still needs to be projected instead of disappearing at goal completion.
      await f.finish();
      await f.harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-2",
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", text: "Native successor answer" }],
          },
        },
      });
      const result = await run;
      expect(readAttemptTerminal(result).promptError).toBeNull();
      expect(result.assistantTexts).toEqual(["Native successor answer"]);
      expect(f.harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
      expect(f.updates.at(-1)).toEqual({ status: "complete" });
      for (const { params } of f.harness.requests.filter(
        ({ method }) => method === "thread/goal/set",
      )) {
        expect(params).toMatchObject({ origin: "automatic" });
      }
    } finally {
      f.revocation.abort();
      await run.catch(() => undefined);
      f.harness.close();
    }
  },
);

it.each(["Stop", "goal Pause"])(
  "pauses native pursuit before releasing the admitted run on %s",
  async (source) => {
    const f = fixture();
    const abort = new AbortController();
    f.params.abortSignal = abort.signal;
    const run = f.run();
    try {
      await f.started(run);
      (source === "Stop" ? abort : f.revocation).abort();
      await run.catch(() => undefined);
      const requests = f.harness.requests;
      const paused = requests.findLastIndex(
        ({ method, params }) =>
          method === "thread/goal/set" && isJsonObject(params) && params.status === "paused",
      );
      const interrupted = requests.findIndex(({ method }) => method === "turn/interrupt");
      expect(paused).toBeGreaterThanOrEqual(0);
      expect(interrupted).toBeGreaterThan(paused);
      expect(f.updates.some(({ status }) => status === "complete")).toBe(false);
    } finally {
      f.revocation.abort();
      await run.catch(() => undefined);
      f.harness.close();
    }
  },
);

it("does not overwrite a different native goal", async () => {
  const f = fixture({
    threadId: "thread-1",
    objective: "Someone else's objective",
    status: "paused",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await expect(f.run()).rejects.toThrow("different native goal");
  expect(
    f.harness.requests.some(
      ({ method }) => method === "thread/goal/set" || method === "turn/start",
    ),
  ).toBe(false);
});

it("stops idle native pursuit on host goal Pause without waiting for another native receipt", async () => {
  const f = fixture();
  const run = f.run();
  const settled = run.catch((error: unknown) => error);
  try {
    await f.started(run);
    const reads = () =>
      f.harness.requests.filter(({ method }) => method === "thread/goal/get").length;
    const beforeSettlement = reads();
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(beforeSettlement));
    f.revocation.abort(new Error("Host goal paused"));
    await settled;
    const paused = f.harness.requests.findLastIndex(
      ({ method, params }) =>
        method === "thread/goal/set" && isJsonObject(params) && params.status === "paused",
    );
    expect(paused).toBeGreaterThan(0);
    expect(f.harness.requests.slice(paused + 1).some(({ method }) => method === "turn/start")).toBe(
      false,
    );
    expect(f.harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(f.updates.some(({ status }) => status === "complete")).toBe(false);
  } finally {
    f.revocation.abort();
    await settled;
    f.harness.close();
  }
});

it("does not begin native execution when the prepared host goal is already revoked", async () => {
  const f = fixture();
  f.revocation.abort(new Error("Host goal cleared"));
  await expect(f.run()).rejects.toThrow("Host goal cleared");
  expect(f.harness.requests).toHaveLength(0);
});

it.each(["paused", "active"] as const)(
  "resumes a %s native goal with a fresh host inference generation before activation",
  async (status) => {
    let activeHarness: ReturnType<typeof createStartedThreadHarness>;
    const respond: Parameters<typeof createStartedThreadHarness>[0] = async (method, params) => {
      if (method === "turn/interrupt") {
        assert(isJsonObject(params) && typeof params.threadId === "string");
        assert(typeof params.turnId === "string");
        await activeHarness.notify({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "interrupted", items: [] },
          },
        });
        return {};
      }
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/resume") {
        return threadStartResult();
      }
      return undefined;
    };
    // Use the neighboring wire/lifecycle fixture so the physical connection is
    // acquired and retired by the real shared-client owner on both runs.
    const first = fixture(null, respond, { persistedThreads: [] });
    activeHarness = first.harness;
    ownCodexInferenceClient(first.harness.client);
    const firstRun = first.run();
    const firstSettled = firstRun.catch((error: unknown) => error);
    try {
      await first.started(firstRun);
      const request = first.harness.requests.find(({ method }) => method === "turn/start")?.params;
      assert(isJsonObject(request) && isJsonObject(request.responsesapiClientMetadata));
      const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
      assert(typeof generation === "string");
      const route = getCodexInferenceThread(first.harness.client, "thread-1");
      assert(route);
      const body = { instructions: "Native model-owned policy", input: [] };
      const metadata = { requestKind: "turn", threadId: "thread-1", generation };
      const oldRequest = route.context.prepare(body, metadata, true);
      oldRequest.assertCurrent();

      first.revocation.abort(new Error("Host goal paused"));
      await firstSettled;
      expect(oldRequest.assertCurrent).toThrow();
      const paused = first.readStoredGoal();
      assert(paused?.status === "paused");
      expect((await readCodexAppServerBinding(first.params.sessionFile))?.threadId).toBe(
        "thread-1",
      );
      first.harness.close();

      const resumed = fixture({ ...paused, status }, respond, { persistedThreads: ["thread-1"] });
      activeHarness = resumed.harness;
      resumed.params.runId = "run-resumed";
      ownCodexInferenceClient(resumed.harness.client);
      const resumedRun = resumed.run();
      try {
        await resumed.started(resumedRun);
        const requests = resumed.harness.requests;
        expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(0);
        expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
        expect(requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
        const turnStart = requests.findIndex(({ method }) => method === "turn/start");
        const activation = requests.findIndex(
          ({ method, params }) =>
            method === "thread/goal/set" && isJsonObject(params) && params.status === "active",
        );
        expect(activation).toBeGreaterThan(turnStart);
        const acceptedRequest = requests[turnStart];
        assert(acceptedRequest);
        const next = acceptedRequest.params;
        assert(isJsonObject(next) && isJsonObject(next.responsesapiClientMetadata));
        expect(next.threadId).toBe("thread-1");
        const nextGeneration = next.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
        assert(typeof nextGeneration === "string");
        expect(nextGeneration).not.toBe(generation);
        const nextRoute = getCodexInferenceThread(resumed.harness.client, "thread-1");
        assert(nextRoute);
        expect(() => nextRoute.context.prepare(body, metadata, true)).toThrow(
          "no current admitted parent generation",
        );
        nextRoute.context
          .prepare(body, { ...metadata, generation: nextGeneration }, true)
          .assertCurrent();
        expect(resumed.readStoredGoal()).toMatchObject({
          threadId: "thread-1",
          objective: paused.objective,
          status: "active",
        });
        expect(
          requests
            .filter(({ method }) => method === "thread/goal/set")
            .every(
              ({ params }) =>
                isJsonObject(params) &&
                params.objective === undefined &&
                params.origin === "automatic",
            ),
        ).toBe(true);
        await resumed.finish();
        await resumed.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect(readAttemptTerminal(await resumedRun).promptError).toBeNull();
      } finally {
        resumed.revocation.abort();
        await resumedRun.catch(() => undefined);
        resumed.harness.close();
      }
    } finally {
      first.revocation.abort();
      await firstSettled;
      first.harness.close();
    }
  },
);

it("joins process exit after a failed native Pause before releasing host tools", async () => {
  const pauseError = new Error("Native Pause rejected");
  let failPause = false;
  const f = fixture(null, async (method, params) => {
    if (
      failPause &&
      method === "thread/goal/set" &&
      isJsonObject(params) &&
      params.status === "paused"
    ) {
      throw pauseError;
    }
    return undefined;
  });
  const events: string[] = [];
  const cleanup = vi.fn(async () => {
    events.push("tools-released");
  });
  setCodexTestToolFactory(f.params, (options) => {
    options?.registerRunCleanup?.(cleanup);
    return [createRuntimeDynamicTool("message")];
  });
  setCodexTestModelSupportsTools(f.params, true);
  f.params.runtimePlan = createCodexRuntimePlanFixture();
  const closeRequested = createDeferred<void>();
  const exited = createDeferred<void>();
  const closeAndWait = f.harness.client.closeAndWait.bind(f.harness.client);
  vi.spyOn(f.harness.client, "closeAndWait").mockImplementation(async (options) => {
    events.push("close-requested");
    closeRequested.resolve();
    // A close request alone is not proof that the native process has exited.
    await exited.promise;
    const result = await closeAndWait(options);
    events.push("exit-joined");
    return result;
  });
  const run = f.run();
  let settled = false;
  const outcome = run
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await run.waitForTurnAccepted();
    await f.started(run);
    failPause = true;
    f.revocation.abort(new Error("Host goal paused"));
    await Promise.race([
      closeRequested.promise,
      outcome.then(() => {
        throw new Error("Attempt settled without joining process exit");
      }),
    ]);
    // Let cancellation continuations run while the process exit remains held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual(["close-requested"]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    exited.resolve();
    expect(await outcome).toBe(pauseError);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events.indexOf("tools-released")).toBeGreaterThan(events.indexOf("exit-joined"));
  } finally {
    exited.resolve();
    f.revocation.abort();
    await outcome;
    f.harness.close();
  }
});

it("holds successor HTTP inference until the native receipt binds both existing owners", async () => {
  const f = fixture(null, async (method, params) => {
    if (method === "account/read") {
      return { account: { type: "apiKey" } };
    }
    if (method === "turn/interrupt") {
      assert(isJsonObject(params) && typeof params.turnId === "string");
      await activeHarness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: params.turnId, status: "interrupted", items: [] },
        },
      });
      return {};
    }
    return undefined;
  });
  const activeHarness: ReturnType<typeof createStartedThreadHarness> = f.harness;
  const { createToolSurfaceAsync: _surface, ...host } = f.params.hostCapabilities;
  f.params.hostCapabilities = createCodexTestHostCapabilities({
    ...host,
    retainSourceAuthority: () => ({
      assertCurrent: () => f.revocation.signal.throwIfAborted(),
      signal: f.revocation.signal,
      bindModelExecution: host.bindModelExecution,
      release: () => {},
    }),
  });
  ownCodexInferenceClient(f.harness.client);
  const run = f.run();
  const runSettled = run.catch(() => undefined);
  const abort = new AbortController();
  let inference: Promise<unknown> | undefined;
  try {
    await f.started(run);
    const route = getCodexInferenceThread(f.harness.client, "thread-1");
    assert(route);
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const bind = vi.fn(
      createCodexInferenceModelBinding({
        client: f.harness.client,
        provider: f.params.provider,
        assertCurrent: () => {},
        memoryConfigured: () => false,
        captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
        resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
      }),
    );
    const dispatch = createCodexInferenceDispatch({
      context: route.context,
      assertCurrent: () => {},
      requireAdmission: true,
      bindModelExecution: bind,
    });
    const provider = vi.fn();
    const bytes = Buffer.from(JSON.stringify({ model: f.params.modelId, instructions: "native" }));
    const headers = (turnId: string) => ({
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread-1",
        turn_id: turnId,
        request_kind: "turn",
      }),
    });
    const pending = dispatch
      .prepare(bytes, "/responses", headers("turn-2"), abort.signal, "http")
      .then((prepared) => {
        try {
          prepared.assertCurrent();
          provider(prepared.bytes);
        } finally {
          prepared.release();
        }
      });
    inference = pending.catch(() => undefined);
    expect(bind).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    await f.harness.notify({
      method: "turn/started",
      params: {
        threadId: "foreign-thread",
        turn: { id: "turn-2", status: "inProgress", items: [] },
      },
    });
    expect(bind).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    await f.harness.notify({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "inProgress", items: [] },
      },
    });
    await pending;
    expect(bind).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(f.harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    const waiting = dispatch.prepare(bytes, "/responses", headers("turn-3"), abort.signal, "http");
    inference = waiting.catch(() => undefined);
    const refused = expect(waiting).rejects.toThrow();
    f.revocation.abort(new Error("Host goal paused before next receipt"));
    await refused;
    await runSettled;
    expect(bind).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
  } finally {
    abort.abort();
    f.revocation.abort();
    await inference;
    await runSettled;
    f.harness.close();
  }
});

it.each(["paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const)(
  "reconciles %s native goals without inventing a user mutation",
  async (status) => {
    const f = fixture({
      threadId: "thread-1",
      objective: "Finish the fixture goal",
      status,
      tokenBudget: status === "paused" ? null : 70,
      tokensUsed: 70,
      timeUsedSeconds: 12,
      createdAt: 1,
      updatedAt: 1,
    });
    Object.assign(f.capability, { tokenBudget: 30 });
    const run = f.run();
    try {
      await f.started(run);
      expect(f.readGoalAtTurnStart()).toMatchObject({
        status: status === "budgetLimited" ? "budgetLimited" : "paused",
        tokenBudget: 100,
        tokensUsed: 70,
      });
      expect(f.readStoredGoal()).toMatchObject({
        tokenBudget: 100,
        tokensUsed: 70,
        timeUsedSeconds: 12,
        objective: f.capability.objective,
        status: "active",
      });
      const reconcile = f.harness.requests.findIndex(
        ({ method, params }) =>
          method === "thread/goal/set" &&
          isJsonObject(params) &&
          params.tokenBudget === 100 &&
          params.status === "paused" &&
          params.origin === "automatic",
      );
      expect(reconcile).toBeGreaterThanOrEqual(0);
      for (const { params } of f.harness.requests.filter(
        ({ method }) => method === "thread/goal/set",
      )) {
        expect(params).toMatchObject({ origin: "automatic" });
      }
      expect(f.harness.requests.findIndex(({ method }) => method === "turn/start")).toBeGreaterThan(
        reconcile,
      );
      expect(f.updates).not.toContainEqual({ status: "complete" });
      await f.finish();
      await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    } finally {
      f.revocation.abort();
      await run.catch(() => undefined);
      f.harness.close();
    }
  },
);

it("explicitly clears the native finite cap on unlimited Resume without resetting usage", async () => {
  const f = fixture({
    threadId: "thread-1",
    objective: "Finish the fixture goal",
    status: "budgetLimited",
    tokenBudget: 70,
    tokensUsed: 70,
    timeUsedSeconds: 12,
    createdAt: 1,
    updatedAt: 1,
  });
  const run = f.run();
  try {
    await f.started(run);
    expect(f.readGoalAtTurnStart()).toMatchObject({
      status: "budgetLimited",
      tokenBudget: null,
      tokensUsed: 70,
    });
    expect(f.readStoredGoal()).toMatchObject({
      tokenBudget: null,
      tokensUsed: 70,
      status: "active",
    });
    expect(
      f.harness.requests.find(({ method }) => method === "thread/goal/set")?.params,
    ).toMatchObject({ tokenBudget: null, status: "paused", origin: "automatic" });
    await f.finish();
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  } finally {
    f.revocation.abort();
    await run.catch(() => undefined);
    f.harness.close();
  }
});

it("refuses a managed native budget clamp before turn admission", async () => {
  const clamped: CodexThreadGoal = {
    threadId: "thread-1",
    objective: "Finish the fixture goal",
    status: "paused",
    tokenBudget: 50,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  let changed = false;
  const f = fixture(clamped, async (method) => {
    if (method === "thread/goal/set") {
      changed = true;
      return { goal: clamped };
    }
    if (method === "thread/goal/get" && changed) {
      return { goal: clamped };
    }
    return undefined;
  });
  await expect(f.run()).rejects.toThrow("not accepted exactly");
  expect(f.harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
});

it.each([false, true])(
  "retains custody after failed Pause with exited=%s and uncertain cleanup",
  async (exited) => {
    let failPause = false;
    const f = fixture(
      null,
      async (method, params) => {
        if (
          failPause &&
          method === "thread/goal/set" &&
          isJsonObject(params) &&
          params.status === "paused"
        ) {
          throw new Error("Pause rejected");
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const cleanup = vi.fn(async () => {});
    setCodexTestToolFactory(f.params, (options) => {
      options?.registerRunCleanup?.(cleanup);
      return [createRuntimeDynamicTool("message")];
    });
    setCodexTestModelSupportsTools(f.params, true);
    f.params.runtimePlan = createCodexRuntimePlanFixture();
    // Mock only the OS receipt; retain the real client's close and cleanup owners.
    const close = vi
      .spyOn(transport, "closeCodexAppServerTransportAndWait")
      .mockResolvedValue({ exited, cleanup: "uncertain" });
    const run = f.run();
    const settled = run.catch((error: unknown) => error);
    try {
      await f.started(run);
      failPause = true;
      f.revocation.abort();
      expect(await settled).toMatchObject({ message: expect.stringContaining("custody retained") });
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.harness.client.getCloseError()).toBeDefined();
      expect(f.harness.client.hasUnsettledCloseCleanup()).toBe(true);
      expect(getSharedCodexAppServerClientState().isolatedClients.has(f.harness.client)).toBe(true);
      await f.harness.client.closeAndWait();
      await expect(
        retainSharedCodexAppServerClientByInstanceId(f.harness.client.getInstanceId()),
      ).rejects.toThrow("replacement refused");
      expect(cleanup).not.toHaveBeenCalled();
      close.mockResolvedValue({ exited: true, cleanup: "closed" });
      await f.harness.client.closeAndWait();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(f.harness.client.hasUnsettledCloseCleanup()).toBe(false);
      expect(getSharedCodexAppServerClientState().isolatedClients.has(f.harness.client)).toBe(
        false,
      );
    } finally {
      f.revocation.abort();
      await settled;
      close.mockResolvedValue({ exited: true, cleanup: "closed" });
      await f.harness.client.closeAndWait();
      close.mockRestore();
      f.harness.close();
    }
  },
);

it("rotates real native hook and process admission on a successor without local inference", async () => {
  const f = fixture();
  const { createToolSurfaceAsync: _surface, ...host } = f.params.hostCapabilities;
  f.params.hostCapabilities = createCodexTestHostCapabilities({
    ...host,
    retainSourceAuthority: () => ({
      assertCurrent: () => f.revocation.signal.throwIfAborted(),
      signal: f.revocation.signal,
      modelPolicyRequired: false,
      bindModelExecution: host.bindModelExecution,
      release: () => {},
    }),
  });
  const bind = vi.spyOn(CodexNativeProcessAuthority.prototype, "bindTurn");
  const run = f.run({ nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } });
  let process: ReturnType<ReturnType<typeof getCodexNativeProcessClient>["claim"]> | undefined;
  try {
    await f.started(run);
    expect(getCodexInferenceThread(f.harness.client, "thread-1")).toBeUndefined();
    const owner = bind.mock.contexts[0];
    assert(owner instanceof CodexNativeProcessAuthority);
    const invoke = (turnId: string) =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: buildCodexNativeHookRelayId({
          agentId: "main",
          sessionId: f.params.sessionId,
          sessionKey: f.params.sessionKey,
        }),
        event: "pre_tool_use",
        rawPayload: {
          session_id: "thread-1",
          turn_id: turnId,
          tool_name: "exec_command",
          tool_use_id: `hook-${turnId}`,
          tool_input: { command: "pwd" },
        },
      });
    expect((await invoke("turn-1")).exitCode).toBe(0);
    owner.admit(
      f.harness.client,
      { threadId: "thread-1", turnId: "turn-1", itemId: "old-command" },
      () => {},
    );
    process = getCodexNativeProcessClient(f.harness.client).claim(
      { threadId: "thread-1", toolCallId: "old-command" },
      async () => {},
    );
    const oldProcess = process;
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await f.harness.notify({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
    });
    expect((await invoke("turn-2")).exitCode).toBe(0);
    await expect(invoke("turn-1")).rejects.toThrow("stale registration");
    expect(oldProcess.assertAdmission).toThrow();
    oldProcess.settle();
    expect(() =>
      owner.admit(
        f.harness.client,
        { threadId: "thread-1", turnId: "turn-1", itemId: "late" },
        () => {},
      ),
    ).toThrow("admitted turn");
    owner.admit(
      f.harness.client,
      { threadId: "thread-1", turnId: "turn-2", itemId: "next-command" },
      () => {},
    );
    process = getCodexNativeProcessClient(f.harness.client).claim(
      { threadId: "thread-1", toolCallId: "next-command" },
      async () => {},
    );
    process.assertAdmission();
    process.settle();
    expect(bind.mock.calls.filter((invocation) => invocation[2] === "turn-2")).toHaveLength(1);
    await f.finish();
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "turn-2" });
    await run;
  } finally {
    process?.settle();
    f.revocation.abort();
    await run.catch(() => undefined);
    f.harness.close();
  }
});

it.each([
  { status: "complete", local: true },
  { status: "blocked", local: false },
] as const)(
  "keeps the real host $status answer but cancels native successors (local=$local)",
  async ({ status, local }) => {
    const pauseRequested = createDeferred<void>();
    const allowPause = createDeferred<void>();
    const interruptRequested = createDeferred<void>();
    const allowInterrupt = createDeferred<void>();
    let running = false;
    const f = fixture(
      null,
      async (method, params) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (
          running &&
          method === "thread/goal/set" &&
          isJsonObject(params) &&
          params.status === "paused"
        ) {
          pauseRequested.resolve();
          await allowPause.promise;
        }
        if (method === "turn/interrupt") {
          assert(isJsonObject(params) && typeof params.turnId === "string");
          expect(params.turnId).toBe("turn-2"); // Never abort the answer-producing turn.
          interruptRequested.resolve();
          await allowInterrupt.promise;
          await harness.notify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: params.turnId, status: "interrupted", items: [] },
            },
          });
          return {};
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const harness: ReturnType<typeof createStartedThreadHarness> = f.harness;
    const target = {
      agentId: "main",
      sessionKey: f.params.sessionKey!,
      sessionId: f.params.sessionId,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    f.params.agentId = "main";
    f.params.sessionTarget = target;
    f.params.abortSignal = f.revocation.signal;
    f.params.config = {
      tools: {
        allow: ["create_goal", "update_goal", "message"],
        codeMode: false,
        toolSearch: false,
      },
    };
    const tools = await createOpenClawCodingToolsAsync({
      config: f.params.config,
      sessionKey: target.sessionKey,
    });
    const create = tools.find((tool) => tool.name === "create_goal");
    const update = tools.find((tool) => tool.name === "update_goal");
    assert(create && update);
    await create.execute("seed", { objective: f.capability.objective });
    const original = (await getSessionEntryAsync(target))?.goal;
    assert(original);
    const effect = createRuntimeDynamicTool("message");
    const cleanup = vi.fn(async () => {});
    setCodexTestToolFactory(f.params, (options) => {
      options?.registerRunCleanup?.(cleanup);
      return [update, effect];
    });
    setCodexTestModelSupportsTools(f.params, true);
    f.params.runtimePlan = createCodexRuntimePlanFixture();
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(f.params);
    if (local) {
      ownCodexInferenceClient(harness.client);
    }
    const bind = vi.spyOn(CodexNativeProcessAuthority.prototype, "bindTurn");
    const run = f.run({ nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } });
    const cancelledProcesses = vi.spyOn(CodexNativeProcessAuthority.prototype, "cancelTurn");
    const outcome = run.catch((error: unknown) => error);
    let toolReply: Promise<unknown> | undefined;
    let nextEffect: Promise<unknown> | undefined;
    let inference: Promise<unknown> | undefined;
    try {
      await run.waitForTurnAccepted();
      await vi.waitFor(() => expect(f.readStoredGoal()?.status).toBe("active"));
      running = true;
      const call = (turnId: string, tool: string, args: JsonObject) =>
        harness.handleServerRequest({
          id: `${turnId}-${tool}`,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId,
            callId: `${turnId}-${tool}`,
            namespace: null,
            tool,
            arguments: args,
          },
        });
      toolReply = call("turn-1", "update_goal", { status, note: "Verified host verdict" });
      await Promise.race([
        pauseRequested.promise,
        toolReply.then(() => {
          throw new Error("Goal tool returned without suspending native pursuit");
        }),
        outcome.then(() => {
          throw new Error("Attempt ended before the tool verdict");
        }),
      ]);
      expect((await getSessionEntryAsync(target))?.goal).toMatchObject({ id: original.id, status });
      expect(f.readStoredGoal()?.status).toBe("active");
      // Deliver the native scheduler's in-flight receipt before the old finalizer
      // can wake, while the Pause RPC is still pending. It must not gain effects.
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", text: "The checked final answer" }],
          },
        },
      });
      await harness.notify({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
      });
      nextEffect = call("turn-2", "message", {}).catch(() => undefined);
      const owner = bind.mock.contexts[0];
      assert(owner instanceof CodexNativeProcessAuthority);
      expect(() =>
        owner.admit(
          harness.client,
          {
            threadId: "thread-1",
            turnId: "turn-2",
            itemId: "next-command",
          },
          () => {},
        ),
      ).toThrow();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: buildCodexNativeHookRelayId({
            agentId: "main",
            sessionId: f.params.sessionId,
            sessionKey: f.params.sessionKey,
          }),
          event: "pre_tool_use",
          rawPayload: {
            session_id: "thread-1",
            turn_id: "turn-2",
            tool_name: "exec_command",
            tool_use_id: "next-hook",
            tool_input: { command: "pwd" },
          },
        }),
      ).rejects.toThrow();
      const provider = vi.fn();
      const route = getCodexInferenceThread(harness.client, "thread-1");
      expect(Boolean(route)).toBe(local);
      if (route) {
        const dispatch = createCodexInferenceDispatch({
          context: route.context,
          assertCurrent: () => {},
          requireAdmission: true,
          bindModelExecution: createCodexInferenceModelBinding({
            client: harness.client,
            provider: f.params.provider,
            assertCurrent: () => {},
            memoryConfigured: () => false,
            captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
            resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
          }),
        });
        inference = dispatch
          .prepare(
            Buffer.from(JSON.stringify({ model: f.params.modelId, instructions: "native" })),
            "/responses",
            {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: "thread-1",
                turn_id: "turn-2",
                request_kind: "turn",
              }),
            },
            f.revocation.signal,
            "http",
          )
          .then((prepared) => {
            try {
              prepared.assertCurrent();
              provider(prepared.bytes);
            } finally {
              prepared.release();
            }
          })
          .catch(() => undefined);
      }
      expect(bind.mock.calls.some((invocation) => invocation[2] === "turn-2")).toBe(false);
      allowPause.resolve();
      await interruptRequested.promise;
      expect(cleanup).not.toHaveBeenCalled();
      expect(effect.execute).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      await patchSessionEntry({
        ...target,
        update: (entry) => {
          assert(entry.goal);
          return { goal: { ...entry.goal, tokensUsed: 7 } };
        },
      });
      allowInterrupt.resolve();
      await toolReply;
      const result = await run;
      await Promise.all([nextEffect, inference]);
      expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, promptError: null });
      expect(result.assistantTexts).toEqual(["The checked final answer"]);
      expect((await getSessionEntryAsync(target))?.goal).toMatchObject({
        id: original.id,
        status,
        lastStatusNote: "Verified host verdict",
        tokensUsed: 7,
      });
      expect(f.readStoredGoal()?.status).toBe("paused");
      expect(cancelledProcesses).toHaveBeenCalledWith(harness.client, "thread-1", "turn-2");
      expect(effect.execute).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      allowPause.resolve();
      allowInterrupt.resolve();
      f.revocation.abort();
      await Promise.allSettled([outcome, toolReply, nextEffect, inference]);
      closeHost();
      harness.close();
    }
  },
);
