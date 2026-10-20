import path from "node:path";
import * as toolRuntime from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
} from "./attempt-timeouts.js";
import { CodexAppServerClient } from "./client.js";
import * as dynamicToolExecution from "./dynamic-tool-execution.js";
import { readItem } from "./event-projector-values.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import { isJsonObject, type CodexThreadItem, type CodexTurn, type RpcMessage } from "./protocol.js";
import {
  createRuntimeDynamicTool,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { createClientHarness } from "./test-support.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

setupRunAttemptTestHooks();

function installRemoteTurn(params = createTestParams()) {
  const accepted = createDeferred<void>();
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  const resumed = createDeferred<void>();
  const resultAccepted = createDeferred<void>();
  const toolAborted = createDeferred<void>();
  let toolWasAborted = false;
  let toolExecutionSignal: AbortSignal | undefined;
  const agentEvents = vi.fn();
  params.onAgentEvent = agentEvents;
  const previousManaged = testCodexAppServerBindingStore.managedThreads;
  const managed = new Map<string, StoredCodexManagedThread>();
  testCodexAppServerBindingStore.managedThreads = createCodexManagedThreadStore({
    entries: async () => [...managed].map(([key, value]) => ({ key, value, createdAt: 0 })),
    registerIfAbsent: async (key, value) => {
      managed.set(key, value);
      return true;
    },
  });
  onTestFinished(() => {
    testCodexAppServerBindingStore.managedThreads = previousManaged;
  });
  // The real worker-backed harness takes about 7.5s to prepare cold. Keep real
  // absolute execution/RPC deadlines while allowing that setup within this run.
  params.timeoutMs = 20_000;
  const fixtureStartedAt = performance.now();
  const timeline: string[] = [];
  const trace = (event: string) =>
    timeline.push(`${Math.round(performance.now() - fixtureStartedAt)}ms:${event}`);
  params.onExecutionPhase = (event) => {
    trace(`phase:${event.phase}`);
    if (event.phase === "turn_accepted") {
      accepted.resolve();
    }
  };
  const faults = {
    unavailable: false,
    restarted: false,
    revoked: false,
    holdRead: false,
    dropStartAck: false,
    closeAfterResume: false,
    suppressFirstTool: false,
    dropToolResult: false,
    snapshotReadFails: false,
    snapshotMismatch: false,
    rememberCompletedTool: false,
    terminalAnswer: false,
  };
  const readRequested = createDeferred<void>();
  const cancel = new AbortController();
  const cancellations = [cancel];
  params.abortSignal = cancel.signal;
  let releaseRead = () => {};
  params.hostCapabilities = createCodexTestHostCapabilities({
    assertActive: () => {
      if (faults.revoked) {
        throw new Error("fixture host authority revoked");
      }
    },
  });
  const execute = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
    toolExecutionSignal = signal;
    const abort = () => {
      toolWasAborted = true;
      toolAborted.resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    started.resolve();
    await Promise.race([finish.promise, toolAborted.promise]);
    signal?.removeEventListener("abort", abort);
    signal?.throwIfAborted();
    return { content: [{ type: "text" as const, text: "effect completed once" }], details: {} };
  });
  setCodexTestToolFactory(params, () => [{ ...createRuntimeDynamicTool("write_once"), execute }]);
  setCodexTestModelSupportsTools(params, true);
  const wires: ReturnType<typeof createClientHarness>[] = [];
  const wireAt = (index: number) => {
    const wire = wires[index];
    if (!wire) {
      throw new Error(`Missing Codex fixture connection ${index}`);
    }
    return wire;
  };
  const historyItems: CodexThreadItem[] = [];
  let currentTurn: CodexTurn = turnStartResult().turn;
  let threadId = "thread-1";
  let starts = 0;
  let threadStarts = 0;
  let unloaded = false;
  const native = () => ({
    ...threadStartResult(threadId),
    thread: {
      ...threadStartResult(threadId).thread,
      status: {
        activeFlags: [],
        type:
          faults.restarted || unloaded
            ? "notLoaded"
            : currentTurn.status === "inProgress"
              ? "active"
              : "idle",
      },
      turns: [{ ...currentTurn, items: [...historyItems, ...currentTurn.items] }],
    },
  });
  const toolRequest = {
    id: "pending-tool",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "write-once",
      namespace: null,
      tool: "write_once",
      arguments: {},
    },
  };
  setCodexAppServerClientFactoryForTest(async (startOptions, _auth, agentDir, config) => {
    if (faults.unavailable) {
      throw new Error("fixture remote app-server unavailable");
    }
    const existing = wires.at(-1);
    if (existing && !existing.client.getCloseError()) {
      return existing.client;
    }
    const wire = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as RpcMessage;
        trace("method" in message ? message.method : `response:${message.id}`);
        if (!("method" in message)) {
          if (message.id === toolRequest.id) {
            expect("result" in message && message.result).toMatchObject({ success: true });
            if (faults.dropToolResult && wires.length === 1) {
              wire.process.emit("error", new Error("WebSocket closed before result delivery"));
              return;
            }
            resultAccepted.resolve();
            currentTurn = turnStartResult("turn-1", "completed").turn;
            if (
              faults.rememberCompletedTool &&
              "result" in message &&
              isJsonObject(message.result)
            ) {
              currentTurn.items = [
                readItem({
                  id: "write-once",
                  type: "dynamicToolCall",
                  tool: "write_once",
                  namespace: null,
                  status: "completed",
                  arguments: {},
                  durationMs: 1,
                  success: message.result.success ?? null,
                  contentItems: message.result.contentItems ?? null,
                })!,
              ];
            }
            if (faults.terminalAnswer) {
              currentTurn.items.push(
                readItem({
                  id: "canonical-answer",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Original task finished.",
                })!,
              );
            }
            send({
              method: "turn/completed",
              params: {
                threadId,
                turn: { ...currentTurn, items: faults.terminalAnswer ? currentTurn.items : [] },
              },
            });
          }
          return;
        }
        let result: unknown = {};
        if (message.method === "initialize") {
          result = { userAgent: "codex-cli/0.153.4" };
        } else if (message.method === "config/read") {
          result = { config: {}, origins: {}, layers: [] };
        } else if (message.method === "configRequirements/read") {
          result = { requirements: null };
        } else if (message.method === "thread/start") {
          threadStarts += 1;
          threadId = `thread-${threadStarts}`;
          result = threadStartResult(threadId);
        } else if (message.method === "thread/read") {
          result = { thread: native().thread };
          if (faults.holdRead) {
            releaseRead = () => send({ id: message.id, result });
            readRequested.resolve();
            return;
          }
        } else if (message.method === "thread/turns/list") {
          if (faults.snapshotReadFails) {
            send({
              id: message.id,
              error: { code: -32000, message: "fixture history unavailable" },
            });
            return;
          }
          if (faults.snapshotMismatch) {
            send({
              id: message.id,
              result: { data: [{ ...currentTurn, id: "foreign-turn" }], nextCursor: null },
            });
            return;
          }
          result = {
            data: [{ ...currentTurn, items: [...historyItems, ...currentTurn.items] }],
            nextCursor: null,
          };
        } else if (message.method === "turn/interrupt") {
          expect(message.params).toMatchObject({ threadId, turnId: currentTurn.id });
          currentTurn = { ...currentTurn, status: "interrupted" };
          unloaded = true;
        } else if (message.method === "thread/resume") {
          result = native();
          if (currentTurn.status === "inProgress") {
            expect(message.params).toEqual({ threadId: "thread-1" });
            // Native 0.153.4 responds before replaying pending server requests.
            send({ id: message.id, result });
            if (faults.closeAfterResume) {
              wire.process.emit("error", new Error("WebSocket closed during recovery"));
              return;
            }
            send(toolRequest);
            resumed.resolve();
            return;
          }
        } else if (message.method === "turn/start") {
          starts += 1;
          if (starts > 1) {
            historyItems.length = 0;
          }
          currentTurn = turnStartResult(`turn-${starts}`).turn;
          if (faults.dropStartAck && starts === 1) {
            wire.process.emit("error", new Error("WebSocket closed with code 1006"));
            return;
          }
          send({ id: message.id, result: { turn: currentTurn } });
          if (starts === 1) {
            if (!faults.suppressFirstTool) {
              send(toolRequest);
            }
          } else {
            currentTurn = turnStartResult(`turn-${starts}`, "completed").turn;
            send({ method: "turn/completed", params: { threadId, turn: currentTurn } });
          }
          return;
        } else if (message.method === "thread/backgroundTerminals/list") {
          result = { data: [], nextCursor: null };
        } else if (message.method === "thread/unsubscribe") {
          unloaded = true;
          result = { status: "notLoaded" };
          send({
            method: "thread/status/changed",
            params: { threadId, status: { type: "notLoaded" } },
          });
        }
        if (message.id !== undefined) {
          send({ id: message.id, result });
        }
      },
    });
    wires.push(wire);
    const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(wire.client);
    try {
      return await getLeasedSharedCodexAppServerClient({
        startOptions,
        authProfileId: null,
        agentDir,
        config,
      });
    } finally {
      start.mockRestore();
    }
  });
  onTestFinished(async () => {
    vi.useRealTimers();
    for (const controller of cancellations) {
      controller.abort("test cleanup");
    }
    finish.resolve();
    await Promise.all(wires.map(({ client }) => client.closeAndWait()));
  });
  const options = {
    pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:19400" } },
  };
  const observe = <T>(promise: Promise<T>, phase: string) =>
    promise.catch((cause: unknown) => {
      throw new Error(`${phase}: ${String(cause)}; timeline=${timeline.join(",")}`, { cause });
    });
  const run = observe(runCodexAppServerAttempt(params, options), "original attempt");
  return {
    params,
    agentEvents,
    faults,
    cancel,
    readRequested,
    releaseRead: () => releaseRead(),
    run,
    accepted,
    started,
    finish,
    resumed,
    resultAccepted,
    toolAborted,
    wireAt,
    execute,
    counts: () => ({ starts, threadStarts }),
    wasToolAborted: () => toolWasAborted,
    isToolSignalAborted: () => toolExecutionSignal?.aborted,
    stopNative: () => {
      currentTurn = turnStartResult("turn-1", "interrupted").turn;
      currentTurn.items = [
        {
          id: "write-once",
          type: "dynamicToolCall",
          tool: "write_once",
          status: "failed",
          success: false,
          contentItems: [],
          namespace: null,
          arguments: {},
          durationMs: null,
          title: null,
          name: null,
          server: null,
          command: null,
          cwd: null,
          query: null,
          aggregatedOutput: null,
          text: "",
          changes: [],
        },
      ];
    },
    snapshotItem: (item: CodexThreadItem) => historyItems.push(item),
    completeNative: (wire: number) => {
      currentTurn = { ...currentTurn, status: "completed" };
      wireAt(wire).send({ method: "turn/completed", params: { threadId, turn: currentTurn } });
    },
    disconnect: () =>
      wireAt(wires.length - 1).process.emit("error", new Error("WebSocket closed with code 1006")),
    next: () => {
      trace("new request");
      const nextCancellation = new AbortController();
      cancellations.push(nextCancellation);
      return observe(
        runCodexAppServerAttempt(
          {
            ...params,
            runId: "run-next",
            prompt: "new request",
            abortSignal: nextCancellation.signal,
          },
          options,
        ),
        "new request",
      );
    },
    methods: () =>
      wires
        .flatMap(({ writes }) => writes.map((line) => JSON.parse(line) as unknown))
        .filter(isJsonObject)
        .map((message) => message.method)
        .filter((method): method is string => typeof method === "string"),
  };
}

async function waitForCheckpoint(
  fixture: ReturnType<typeof installRemoteTurn>,
  checkpoint: Promise<void>,
  phase: string,
) {
  await Promise.race([
    checkpoint,
    fixture.run.then((result) => {
      throw new Error(
        `${phase}: attempt ended (${String(readAttemptTerminal(result).promptError)}); methods=${fixture.methods().join(",")}`,
      );
    }),
  ]);
}

const reachTool = (fixture: ReturnType<typeof installRemoteTurn>) =>
  waitForCheckpoint(fixture, fixture.started.promise, "tool execution");
const reachRecovery = (fixture: ReturnType<typeof installRemoteTurn>) =>
  waitForCheckpoint(fixture, fixture.resumed.promise, "active turn recovery");

describe("Codex active remote turn recovery", () => {
  it("projects completed command and commentary lost during an active turn recovery", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.snapshotItem(
      readItem({
        id: "lost-command",
        type: "commandExecution",
        command: "echo saved",
        cwd: "/tmp",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "saved",
        exitCode: 0,
        durationMs: 1,
      })!,
    );
    fixture.snapshotItem(
      readItem({
        id: "item-2",
        type: "agentMessage",
        phase: "commentary",
        text: "The saved operation finished.",
        delivery: null,
        memoryCitation: null,
        questions: null,
      })!,
    );
    fixture.disconnect();
    await reachRecovery(fixture);
    fixture.finish.resolve();
    const result = await fixture.run;
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(
      result.messagesSnapshot.filter(
        (message) => message.role === "toolResult" && message.toolCallId === "lost-command",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(result.messagesSnapshot)).toContain("The saved operation finished.");
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
    expect(readAttemptTerminal(await fixture.next()).promptError).toBeNull();
  });

  it("retains observed canonical commentary across two recoveries and backfills only missing items", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    const commentary = (id: string, text: string) =>
      readItem({
        id,
        type: "agentMessage",
        phase: "commentary",
        text,
        delivery: null,
        memoryCitation: null,
        questions: null,
      })!;
    const emit = (wire: number, id: string, text: string) =>
      fixture.wireAt(wire).send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: commentary(id, text) },
      });
    emit(0, "canonical-before", "Before reconnect.");
    await vi.waitFor(() =>
      expect(JSON.stringify(fixture.agentEvents.mock.calls)).toContain("Before reconnect."),
    );
    fixture.snapshotItem(commentary("item-1", "Before reconnect."));
    fixture.snapshotItem(commentary("item-2", "Lost during reconnect."));
    fixture.disconnect();
    await reachRecovery(fixture);
    emit(1, "canonical-after", "After reconnect.");
    await vi.waitFor(() =>
      expect(JSON.stringify(fixture.agentEvents.mock.calls)).toContain("After reconnect."),
    );
    fixture.snapshotItem(commentary("item-3", "After reconnect."));
    fixture.disconnect();
    await vi.waitFor(() =>
      expect(fixture.methods().filter((method) => method === "thread/resume")).toHaveLength(2),
    );
    fixture.finish.resolve();
    const result = await fixture.run;
    expect(readAttemptTerminal(result).promptError).toBeNull();
    for (const text of ["Before reconnect.", "Lost during reconnect.", "After reconnect."]) {
      expect(
        result.messagesSnapshot.filter((message) => JSON.stringify(message).includes(text)),
      ).toHaveLength(1);
    }
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
    expect(readAttemptTerminal(await fixture.next()).promptError).toBeNull();
  });

  it.each(["snapshotReadFails", "snapshotMismatch"] as const)(
    "bounds %s without replaying a tool or poisoning the next request",
    async (fault) => {
      const fixture = installRemoteTurn();
      await reachTool(fixture);
      fixture.disconnect();
      await reachRecovery(fixture);
      fixture.faults[fault] = true;
      fixture.finish.resolve();
      const result = await fixture.run;
      expect(readAttemptTerminal(result).promptError).toContain("could not safely reconcile");
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fixture.counts().starts).toBe(1);
      fixture.faults[fault] = false;
      expect(readAttemptTerminal(await fixture.next()).promptError).toBeNull();
    },
  );

  it("acknowledges the original cached tool response proved by terminal history", async () => {
    const acknowledge = vi.spyOn(toolRuntime, "acknowledgeInternalToolResult");
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    fixture.faults.rememberCompletedTool = true;
    fixture.finish.resolve();
    expect(readAttemptTerminal(await fixture.run).promptError).toBeNull();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not turn an unconfirmed recovered checkpoint into successful answer settlement", async () => {
    const params = createTestParams();
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "recovered-checkpoint.sqlite"),
      "session-recovered-checkpoint",
    );
    const fixture = installRemoteTurn(params);
    await reachTool(fixture);
    let writingStarted = false;
    const release = createDeferred<void>();
    const mirror = codexTranscriptMirrorRuntime.mirror;
    vi.spyOn(codexTranscriptMirrorRuntime, "mirror").mockImplementation(async (input) => {
      if (JSON.stringify(input.messages).includes("Recovered checkpoint.")) {
        writingStarted = true;
        await release.promise;
      }
      return await mirror(input);
    });
    fixture.snapshotItem(
      readItem({
        id: "item-checkpoint",
        type: "agentMessage",
        phase: "commentary",
        text: "Recovered checkpoint.",
        delivery: null,
        memoryCitation: null,
        questions: null,
      })!,
    );
    fixture.faults.terminalAnswer = true;
    fixture.disconnect();
    await reachRecovery(fixture);
    vi.useFakeTimers();
    try {
      fixture.finish.resolve();
      await Promise.race([
        vi.waitFor(() => expect(writingStarted).toBe(true), { timeout: 10_000 }),
        fixture.run.then((result) => {
          throw new Error(
            `Ended before recovery checkpoint: ${JSON.stringify(readAttemptTerminal(result))}`,
          );
        }),
      ]);
      await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
      let settled = false;
      void fixture.run.then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 20_000 });
      const result = await fixture.run;
      expect(readAttemptTerminal(result).promptError).toBeTruthy();
      expect(result.replayMetadata).toMatchObject({
        replaySafe: false,
        hadPotentialSideEffects: true,
      });
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  it("rejoins its original turn without repeating the tool effect, then accepts a new request", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    expect((await readCodexAppServerBinding(fixture.params.sessionFile))?.turnRecovery).toEqual({
      turnId: "turn-1",
      state: "accepted",
    });
    fixture.disconnect();
    await reachRecovery(fixture);
    expect(fixture.wasToolAborted()).toBe(false);
    fixture.finish.resolve();
    await waitForCheckpoint(fixture, fixture.resultAccepted.promise, "replayed result acceptance");
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(
      (await readCodexAppServerBinding(fixture.params.sessionFile))?.turnRecovery,
    ).toBeUndefined();
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts()).toEqual({ starts: 1, threadStarts: 1 });
    expect(fixture.wasToolAborted()).toBe(false);
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 1 });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.methods()).not.toContain("turn/interrupt");
  });

  it.each(["unavailable", "restarted", "closeAfterResume"] as const)(
    "isolates %s native work and permits a new user request",
    async (fault) => {
      const fixture = installRemoteTurn();
      await reachTool(fixture);
      fixture.faults[fault] = true;
      fixture.disconnect();
      const result = await fixture.run;
      const failed = readAttemptTerminal(result);
      expect(failed.promptError).toBeDefined();
      expect((await readCodexAppServerBinding(fixture.params.sessionFile))?.turnRecovery).toEqual({
        turnId: "turn-1",
        state: "accepted",
      });
      expect(result.replayMetadata).toMatchObject({
        hadPotentialSideEffects: true,
        replaySafe: false,
      });
      expect(result.codexAppServerFailure).toMatchObject({
        kind: "client_closed_before_turn_completed",
        replaySafe: false,
      });
      expect(failed.timedOut).toBe(false);
      expect(fixture.wasToolAborted()).toBe(true);
      expect(fixture.methods().filter((method) => method === "thread/resume")).toHaveLength(
        fault === "closeAfterResume" ? 1 : 0,
      );
      expect(fixture.counts().starts).toBe(1);
      fixture.faults[fault] = false;
      expect(readAttemptTerminal(await fixture.next())).toMatchObject({
        aborted: false,
        timedOut: false,
      });
      expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 1 });
      expect(fixture.execute).toHaveBeenCalledOnce();
    },
  );

  it("does not replay an accepted turn whose native effects could not be observed", async () => {
    const fixture = installRemoteTurn();
    fixture.faults.suppressFirstTool = true;
    await waitForCheckpoint(fixture, fixture.accepted.promise, "accepted native turn");
    fixture.faults.unavailable = true;
    fixture.disconnect();
    const result = await fixture.run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    expect(result.toolMetas).toHaveLength(0);
    expect(result.replayMetadata).toMatchObject({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(result.codexAppServerFailure).toMatchObject({
      kind: "client_closed_before_turn_completed",
      replaySafe: false,
      replayBlockedReason: "potential_side_effect",
    });
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(fixture.counts().starts).toBe(1);
    fixture.faults.unavailable = false;
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 1 });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("cancels pending work when the recovered terminal snapshot lost its resolution notification", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    fixture.stopNative();
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(fixture.wasToolAborted()).toBe(true);
    expect(fixture.isToolSignalAborted()).toBe(true);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
    expect(fixture.methods().filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not cancel a completed execution when its lost result is resolved on replay", async () => {
    const executions = vi.spyOn(dynamicToolExecution, "handleDynamicToolCallWithTimeout");
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.dropToolResult = true;
    fixture.finish.resolve();
    await reachRecovery(fixture);
    // The tool-facing child signal closes normally after result release. Check
    // the retained execution owner instead, without replacing actual execution.
    const executionSignal = executions.mock.calls[0]?.[0].signal;
    expect(executionSignal?.aborted).toBe(false);
    fixture.wireAt(1).send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "pending-tool" },
    });
    fixture.completeNative(1);
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(executionSignal?.aborted).toBe(false);
    expect(executions).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("propagates native resolution of a replay to the original in-flight tool", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    // Resolve immediately after native resume, before the asynchronous binding
    // admission barrier can deliver the replay to its attempt handler.
    fixture.wireAt(1).send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "pending-tool" },
    });
    await waitForCheckpoint(fixture, fixture.toolAborted.promise, "native tool cancellation");
    fixture.completeNative(1);
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
  });

  it("ignores resolutions for another thread or unknown request during recovery", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    for (const params of [
      { threadId: "sibling-thread", requestId: "pending-tool" },
      { threadId: "thread-1", requestId: "unknown-request" },
    ]) {
      fixture.wireAt(1).send({ method: "serverRequest/resolved", params });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(fixture.wasToolAborted()).toBe(false);
    fixture.finish.resolve();
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("cancels while reconnecting without replaying work or blocking the next request", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.holdRead = true;
    fixture.disconnect();
    await waitForCheckpoint(fixture, fixture.readRequested.promise, "replacement read");
    fixture.cancel.abort("user cancelled");
    await expect(fixture.run).rejects.toThrow(
      "Codex cancellation could not confirm the turn stopped",
    );
    expect(fixture.wasToolAborted()).toBe(true);
    expect(fixture.methods()).not.toContain("thread/resume");
    fixture.faults.holdRead = false;
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 1 });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not replay an unacknowledged turn start and permits a later new request", async () => {
    const fixture = installRemoteTurn();
    fixture.faults.dropStartAck = true;
    const result = await fixture.run;
    expect(readAttemptTerminal(result).promptError).toBeDefined();
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(result.codexAppServerFailure).toMatchObject({ replaySafe: false });
    expect(fixture.counts()).toEqual({ starts: 1, threadStarts: 1 });
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 2 });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not resume or execute again after its host authority is revoked", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.holdRead = true;
    fixture.disconnect();
    await waitForCheckpoint(fixture, fixture.readRequested.promise, "replacement read");
    fixture.faults.revoked = true;
    fixture.releaseRead();
    await fixture.run.catch(() => undefined);
    fixture.faults.revoked = false;
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
  });
});
