/** Subscribed embedded tool lifecycles, including real executor bridge coverage. */
import { getEventListeners } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import { disposeAllCodeModeRuns, waitForPendingBridgeSettlement } from "./code-mode-state.js";
import { createSubscribedCodeModeHarness as subscribeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  pluginToolWithExecute as tool,
  resetCodeModeTestState,
  resultDetails,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { attachInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import { addClientToolsToToolCatalog } from "./tool-search-catalog.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createMessageTool } from "./tools/message-tool-execution.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const harnessDisposers: Array<() => void> = [];
function createHarness(params: Parameters<typeof subscribeHarness>[0]) {
  const harness = subscribeHarness(params);
  if (!params.sessionManager) {
    harnessDisposers.push(harness.dispose);
  }
  const exec = expectDefined(harness.tools[0], "Code Mode exec");
  const wait = expectDefined(harness.tools[1], "Code Mode wait");
  return {
    ...harness,
    exec,
    wait,
    add: (...tools: AnyAgentTool[]) =>
      applyCodeModeCatalog({ ...harness, tools: [...harness.tools, ...tools] }),
    run: async (code: string, signal?: AbortSignal) =>
      resultDetails(await exec.execute("code-call", { code }, signal)),
  };
}

async function persistentHarness(name: string, content: string) {
  const scope = {
    agentId: "main",
    sessionId: `session-code-mode-${name}`,
    sessionKey: `agent:main:${name}`,
    storePath: resolveDefaultSessionStorePath("main"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope);
  manager.appendMessage({ role: "user", content, timestamp: 1 });
  return {
    scope,
    manager,
    harness: createHarness({ name, sessionManager: manager }),
  };
}

describe("Code Mode subscribed bridge lifecycle", () => {
  afterEach(async () => {
    harnessDisposers.splice(0).forEach((dispose) => dispose());
    vi.useRealTimers();
    await resetCodeModeTestState();
    clearRuntimeConfigSnapshot();
  });

  it("admits nested activity when consecutive assistant responses reuse exec_0", async () => {
    await withStateDirEnv("openclaw-code-mode-reused-id-", async () => {
      const { scope, manager, harness } = await persistentHarness(
        "reused-exec-id",
        "Read both records",
      );
      const target = fakeTool("read_record", "Read a record");
      harness.add(target);
      try {
        for (const value of ["first", "second"]) {
          const toolCall = {
            type: "toolCall" as const,
            id: "exec_0",
            name: "exec",
            arguments: { code: `return await read_record({ value: "${value}" });` },
          };
          const assistantMessage = makeAssistantMessageFixture({
            responseId: `chatcmpl-${value}`,
            content: [toolCall],
            stopReason: "toolUse",
          });
          manager.appendMessage(assistantMessage);
          const details = resultDetails(
            await runWithAgentToolExecutionContext({ assistantMessage, toolCall }, () =>
              harness.exec.execute(toolCall.id, toolCall.arguments),
            ),
          );
          const result = await waitUntilCompleted({ details, waitTool: harness.wait });
          expect(result.status, JSON.stringify(result)).toBe("completed");
          expect(result.value).toMatchObject({ input: { value } });
        }

        const activities = await harness.readNestedActivities();
        expect(activities.map(({ details }) => details.input)).toEqual([
          { value: "first" },
          { value: "second" },
        ]);
        expect(new Set(activities.map(({ details }) => details.toolCallId)).size).toBe(2);
        expect(activities.map(({ details }) => details.parentToolCallId)).toEqual([
          "exec_0",
          "exec_0",
        ]);
        const admitted = SessionManager.open(scope)
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" ? [readNestedToolActivity(entry.message)] : [],
          )
          .filter(Boolean);
        expect(admitted).toEqual(activities);
      } finally {
        harness.dispose();
      }
    });
  });

  it("returns a committed source reply after recording its nested tool activity", async () => {
    await withStateDirEnv("openclaw-code-mode-source-reply-", async () => {
      const config = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const { scope, manager, harness } = await persistentHarness(
        "source-reply",
        "Review this format",
      );
      const target = createMessageTool({
        config,
        preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
        currentChannelProvider: "webchat",
        agentSessionKey: scope.sessionKey,
        runSessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        agentId: scope.agentId,
        runId: harness.runId,
      });
      harness.add(target);
      try {
        // Await transcript persistence through the real catalog without a guest wall-clock budget.
        const runtime = new ToolSearchRuntime(
          harness,
          toToolSearchConfig(resolveCodeModeConfig(harness.config)),
          { prepareInput: true, validateInput: true },
        );
        const { result } = await runtime.callExactId(
          "openclaw:core:message",
          { action: "send", message: "Review complete", final: true },
          { parentToolCallId: "code-call-1" },
        );
        const messages = SessionManager.open(scope)
          .getEntries()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        expect(messages.filter((message) => message.role === "assistant")).toEqual([
          expect.objectContaining({ content: [{ type: "text", text: "Review complete" }] }),
        ]);
        expect(result.details).toMatchObject({
          deliveryStatus: "sent",
          sourceReplyTranscriptOwner: true,
        });
        const activities = await harness.readNestedActivities();
        expect(messages.map(readNestedToolActivity).filter(Boolean)).toEqual(activities);
        expect(activities).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({ toolName: "message", isError: false }),
          }),
        ]);
        expect(manager.buildSessionContext().messages.some(readNestedToolActivity)).toBe(false);
      } finally {
        harness.dispose();
      }
    });
  });

  it.each(["redacted", "rejected"])(
    "preserves nested source delivery when output is %s",
    async (projection) => {
      const harness = createHarness({ name: `source-${projection}` });
      const target = fakeTool("message", "Reply to the source conversation");
      target.execute = vi.fn(async () =>
        jsonResult({
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        }),
      );
      const result = harness.executeTool({
        tool: target,
        toolName: "message",
        source: "openclaw",
        sourceName: "core",
        toolCallId: "nested-source-reply",
        parentToolCallId: "outer-exec",
        input: { action: "send", message: "Delivered once" },
        acceptResultBeforeProjection: async () => {
          if (projection === "rejected") {
            throw new Error("declared output mismatch");
          }
          return jsonResult({ redacted: true });
        },
      });
      if (projection === "rejected") {
        await expect(result).rejects.toThrow("declared output mismatch");
      } else {
        await expect(result).resolves.toMatchObject({ details: { redacted: true } });
      }
      expect(target.execute).toHaveBeenCalledOnce();
      expect(harness.subscription.getSourceReplyDelivered()).toBe(true);
      expect(harness.subscription.toolMetas).toEqual([
        expect.objectContaining({ toolName: "message", isError: projection === "rejected" }),
      ]);
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      });
    },
  );

  it("records dispatch order and anchors before concurrent nested calls settle", async () => {
    await withStateDirEnv("nested-tool-history-", async () => {
      const { manager, harness } = await persistentHarness("nested-history", "Read three times");
      const firstStarted = createDeferred();
      const finishFirst = createDeferred();
      const firstAnchor = manager.getLeafId();
      const target = tool("read", "Read a record", async (id) => {
        if (id === "first") {
          firstStarted.resolve();
          await finishFirst.promise;
        }
        return jsonResult({ text: "same result" });
      });
      const call = (toolCallId: string) =>
        harness.executeTool({
          tool: target,
          toolName: "read",
          source: "openclaw",
          toolCallId,
          parentToolCallId: "exec",
          input: {},
          acceptResultBeforeProjection: async (result) => result,
        });
      try {
        const first = call("first");
        await firstStarted.promise;
        await call("second");
        finishFirst.resolve();
        await first;
        const nextAnchor = await manager.appendMessageAsync({
          role: "user",
          content: "Read the next record",
          timestamp: 2,
        });
        await call("third");
        const activity = (await harness.readNestedActivities())
          .map(({ details }) => ({
            id: details.toolCallId,
            order: details.startOrder,
            anchor: details.afterEntryId,
          }))
          .toSorted((a, b) => a.order - b.order);
        expect(activity).toEqual([
          { id: "first", order: 0, anchor: firstAnchor },
          { id: "second", order: 1, anchor: firstAnchor },
          { id: "third", order: 2, anchor: nextAnchor },
        ]);
      } finally {
        finishFirst.resolve();
        harness.dispose();
      }
    });
  });

  it("aborts promptly while a terminal observer stalls and disposes preparation once", async () => {
    const observing = createDeferred();
    const release = createDeferred();
    const dispose = vi.fn();
    const harness = createHarness({
      name: "stalled-terminal",
      onToolStreamBoundary: async () => {
        observing.resolve();
        await release.promise;
      },
    });
    const target = tool("read", "Read a record", async () => jsonResult({ ok: true }));
    attachInternalToolExecutionPreparer(target, async () => ({
      kind: "ready",
      args: {},
      dispose,
      execute: async (start) => {
        start?.();
        return jsonResult({ ok: true });
      },
    }));
    try {
      const pending = harness.executeTool({
        tool: target,
        toolName: "read",
        source: "openclaw",
        toolCallId: "stalled-terminal",
        input: {},
        acceptResultBeforeProjection: async (result) => result,
      });
      await observing.promise;
      harness.runAbortController.abort();
      await expect(pending).rejects.toThrow("Aborted");
      expect(dispose).toHaveBeenCalledOnce();
      release.resolve();
      await harness.subscription.waitForPendingEvents();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
  });

  it("keeps direct sessions_yield handoff successful while closing sibling Code Mode cells", async () => {
    const harness = createHarness({ name: "yield-handoff" });
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const onYield = vi.fn(() => harness.runAbortController.abort(handoffReason));
    const target = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: harness.sessionId,
        claimYield: () => true,
        onYield,
      }),
      harness.runAbortController.signal,
    );
    const surface = harness.add(target);
    const parked = await harness.run("await yield_control(); return 'unreachable';");
    expect(parked.status).toBe("waiting");
    expect(
      harness.catalogRef.current?.entries.some((entry) => entry.name === "sessions_yield"),
    ).toBe(false);
    const direct = expectDefined(
      surface.tools.find((entry) => entry.name === "sessions_yield"),
      "direct handoff tool",
    );
    expect(resultDetails(await direct.execute("yield-handoff", {}))).toMatchObject({
      status: "yielded",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
    await expect(harness.wait.execute("closed-sibling", { runId: parked.runId })).rejects.toBe(
      handoffReason,
    );
  });

  it("releases only the parked owner after catalog closure without wait", async () => {
    const owner = createHarness({ name: "parked-catalog" });
    const survivor = createHarness({ name: "survivor-catalog" });
    const code = 'setTimeout(() => {}, 60_000); await yield_control("pause"); return "done";';
    applyCodeModeCatalog(owner);
    applyCodeModeCatalog(survivor);

    const parked = await owner.run(code);
    const other = await survivor.run(code);
    for (const result of [parked, other]) {
      expect(result).toMatchObject({ status: "waiting", runId: expect.any(String) });
    }
    const ownerId = parked.runId as string;
    const survivorId = other.runId as string;
    const ownerState = expectDefined(testing.activeRuns.get(ownerId), "parked owner snapshot");
    const survivorState = expectDefined(testing.activeRuns.get(survivorId), "survivor snapshot");
    const pending = expectDefined(
      ownerState.pending.find((entry) => entry.method === "sleep"),
      "owner timer",
    );
    const otherPending = expectDefined(
      survivorState.pending.find((entry) => entry.method === "sleep"),
      "survivor timer",
    );
    expect(pending.settled).toBeUndefined();
    expect(otherPending.settled).toBeUndefined();
    expect(ownerState.continuation.retainedBytes).toBeGreaterThan(0);
    expect(testing.resumingRunIds.size).toBe(0);

    // Both exec calls have returned; no wait is in flight to perform owner cleanup.
    clearToolSearchCatalog(owner);
    expect([...testing.activeRuns.keys()]).toEqual([survivorId]);
    await waitForPendingBridgeSettlement([pending], { kind: "awaiting" });
    expect(() => pending.reply.take()).toThrow("unavailable");
    expect(testing.activeRuns.get(survivorId)).toBe(survivorState);
    expect(otherPending.settled).toBeUndefined();
  });

  it("transfers parked ownership across refresh and repeated resumes before completion", async () => {
    const owner = createHarness({ name: "transfer-complete" });
    applyCodeModeCatalog(owner);
    const { exec, wait } = owner;
    let controller = new AbortController();
    let result = resultDetails(
      await exec.execute(
        "transfer-exec",
        {
          code: `await yield_control("first");
                await yield_control("second");
                await yield_control("third");
                return "done";`,
        },
        controller.signal,
      ),
    );
    expect(result.status, JSON.stringify(result)).toBe("waiting");
    const runId = result.runId as string;
    controller.abort(new Error("exec observer finished"));
    applyCodeModeCatalog(owner);
    addClientToolsToToolCatalog({
      enabled: true,
      ...owner,
      tools: [fakeTool("client_probe", "Client probe")],
    });

    for (let index = 0; index < 2; index += 1) {
      controller = new AbortController();
      result = resultDetails(
        await wait.execute(`transfer-wait-${index}`, { runId }, controller.signal),
      );
      expect(result).toMatchObject({ status: "waiting", runId });
      controller.abort(new Error("wait observer finished"));
    }

    const finalState = expectDefined(testing.activeRuns.get(runId), "final snapshot");
    const pending = finalState.pending;
    expect(resultDetails(await wait.execute("transfer-complete", { runId }))).toMatchObject({
      status: "completed",
      value: "done",
    });
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
    await waitForPendingBridgeSettlement(pending, {
      kind: "draining",
      requiredRequestIds: pending.map((entry) => entry.id),
    });
    expect(getEventListeners(finalState.owner.signal, "abort")).toHaveLength(0);
    expect(finalState.owner.signal.aborted).toBe(true);
    expect(owner.catalogRef.onDispose?.size ?? 0).toBe(0);
  });

  it("does not publish a snapshot after its catalog closes during wait", async () => {
    // Worker startup must not consume the host budget before close_owner dispatches.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = createHarness({ name: "close-during-wait" });
    const closeOwner = tool("close_owner", "Close the run catalog", async () => {
      clearToolSearchCatalog(owner);
      return jsonResult({ closed: true });
    });
    owner.add(closeOwner);
    const parked = await owner.run(`await yield_control("initial");
            await close_owner({});
            await yield_control("closed");
            return "unreachable";`);
    expect(parked.status).toBe("waiting");
    const completion = owner.wait.execute("close-during-wait", {
      runId: parked.runId,
    });
    expect(resultDetails(await completion)).toMatchObject({
      status: "failed",
      code: "aborted",
    });
    expect(owner.catalogRef.current).toBeUndefined();
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
    expect(countActiveToolExecutions(owner.runId)).toBe(0);
  });

  it("does not return a closed snapshot when owner abort races the wait deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = createHarness({
      name: "abort-wait-deadline",
      timeoutMs: 1_500,
    });
    const lifecycle = vi.spyOn(owner.subscription, "runToolLifecycle");
    const started = createDeferred();
    const stalled = tool("stalled", "Await cancellation", async () => {
      started.resolve();
      return await new Promise<never>(() => {});
    });
    owner.add(stalled);
    try {
      const execution = owner.exec.execute("deadline-exec", {
        code: "return await stalled({});",
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_500);
      const parked = resultDetails(await execution);
      expect(parked.status).toBe("waiting");
      const waiting = owner.wait.execute("deadline-wait", {
        runId: parked.runId,
      });
      vi.advanceTimersByTime(1_499);
      owner.runAbortController.abort();
      expect(resultDetails(await waiting)).toMatchObject({ status: "failed", code: "aborted" });
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
      // Abort returns before nested transcript and terminal finalization; join its owner.
      expect(lifecycle).toHaveBeenCalledOnce();
      await expect(lifecycle.mock.results[0]?.value).rejects.toThrow("Aborted");
      expect(countActiveToolExecutions(owner.runId)).toBe(0);
    } finally {
      lifecycle.mockRestore();
    }
  });

  it("keeps sequential exclusion after cell cancellation until implementation rejection", async () => {
    const harness = createHarness({
      name: "sequential-cancel-reject",
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const started = createDeferred();
    const downstream = createDeferred();
    const events: string[] = [];
    let calls = 0;
    const target = tool("ordered_target", "Write without observing cancellation", async () => {
      const call = ++calls;
      events.push(`${call}:start`);
      if (call === 1) {
        started.resolve();
        try {
          await downstream.promise;
        } finally {
          events.push(`${call}:settled`);
        }
      } else {
        events.push(`${call}:settled`);
      }
      return jsonResult({ call });
    });
    target.executionMode = "sequential";
    harness.add(target);
    const { exec, wait } = harness;
    try {
      const first = exec.execute(
        "cancelled-cell",
        { code: "return await ordered_target({});" },
        controller.signal,
      );
      await started.promise;
      controller.abort();
      expect(resultDetails(await first)).toMatchObject({ status: "failed", code: "aborted" });
      expect(harness.runAbortController.signal.aborted).toBe(false);
      expect(events).toEqual(["1:start"]);

      // A second real cell must reach the shared catalog while the first source
      // still owns its write. Its observer deadline does not release that write.
      const second = exec.execute("following-cell", {
        code: "return await ordered_target({});",
      });
      // The worker uses performance.now(), so wait on the real cell deadline
      // instead of advancing only its host timers ahead of that clock.
      const following = resultDetails(await second);
      expect(following.status).toBe("waiting");
      expect(events).toEqual(["1:start"]);
      expect(target.execute).toHaveBeenCalledOnce();

      downstream.reject(new Error("late implementation failure"));
      expect(await waitUntilCompleted({ details: following, waitTool: wait })).toMatchObject({
        status: "completed",
        value: { call: 2 },
      });
      expect(events).toEqual(["1:start", "1:settled", "2:start", "2:settled"]);
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
    } finally {
      downstream.resolve();
    }
  });

  it.each([
    { kind: "snapshot expiry", close: "expire" },
    { kind: "gateway shutdown", close: "shutdown" },
  ] as const)(
    "settles an abort-ignoring subscribed tool exactly once after $kind",
    async ({ close }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const downstream = createDeferred();
      const started = createDeferred();
      const toolAbort = vi.fn();
      const harness = createHarness({
        name: `closure-${close}`,
        timeoutMs: 2_000,
      });
      const target = tool(
        "stalled_target",
        "Ignore cancellation",
        async (_toolCallId, _input, signal) => {
          expectDefined(signal, "nested tool cancellation signal").addEventListener(
            "abort",
            toolAbort,
          );
          started.resolve();
          await downstream.promise;
          return jsonResult({ late: true });
        },
      );
      const continuation = tool("continue_after_target", "Continue the guest", async () =>
        jsonResult({ continued: true }),
      );
      harness.add(target, continuation);

      try {
        const execution = harness.exec.execute(`code-call-${close}`, {
          code: `const target = stalled_target({});
                try { await target; } catch (error) { return error.message; }
                return await continue_after_target({});`,
        });
        await started.promise;
        await vi.advanceTimersByTimeAsync(2_000);
        const suspended = resultDetails(await execution);
        expect(suspended.status).toBe("waiting");
        expect(target.execute).toHaveBeenCalledOnce();
        expect(countActiveToolExecutions(harness.runId)).toBe(1);

        const parked = testing.activeRuns.get(suspended.runId as string);
        const pending = parked?.pending.find((entry) => entry.method === "callValue");
        expect(pending).toBeDefined();
        if (!parked || !pending) {
          throw new Error("expected one parked subscribed tool call");
        }
        const { wait } = harness;
        const waiting =
          close === "expire"
            ? undefined
            : wait.execute(`code-wait-${close}`, { runId: suspended.runId });

        if (close === "expire") {
          parked.expiresAt = performance.now() - 1;
          testing.removeExpiredRuns();
        } else {
          await disposeAllCodeModeRuns();
        }

        if (waiting) {
          const result = resultDetails(await waiting);
          expect(result.status).not.toBe("waiting");
        } else {
          await waitForPendingBridgeSettlement([pending], { kind: "awaiting" });
          await expect(
            wait.execute("code-wait-after-expiry", { runId: suspended.runId }),
          ).rejects.toThrow("code mode run is unavailable or expired");
        }
        expect(() => pending.reply.take()).toThrow("unavailable");
        await vi.waitFor(() => expect(countActiveToolExecutions(harness.runId)).toBe(0));
        expect(toolAbort).toHaveBeenCalledOnce();
        expect(harness.subscription.getItemLifecycle().activeCount).toBe(0);
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);

        downstream.resolve();
        await Promise.resolve();
        expect(target.execute).toHaveBeenCalledOnce();
        expect(continuation.execute).not.toHaveBeenCalled();
        expect(toolAbort).toHaveBeenCalledOnce();
      } finally {
        downstream.resolve();
      }
    },
  );
});
