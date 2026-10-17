// Codex tests cover run attempt thread cleanup plugin behavior.
import path from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createNativeRunParams as createParams,
  mockClientRuntimeMethods,
  multiplexCodexTestClientHandlers,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";
import * as sharedClient from "./shared-client.js";
import {
  retainSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import {
  adaptCodexTestClientFactory,
  createInferenceReadyClientHarness,
  waitForHarnessRequest,
  withoutCodexSkillDiscovery,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// The keyed router, client runtime, and subagent monitor each add handlers on
// the physical client; single-slot mocks would keep only the last one.
function multiplexedClientFactory(
  factory: CodexTestAppServerClientFactory,
): CodexAppServerClientFactory {
  return adaptCodexTestClientFactory(async (...args) => {
    const client = await factory(...args);
    multiplexCodexTestClientHandlers(client);
    return client;
  });
}

type Harness = ReturnType<typeof createInferenceReadyClientHarness>;

async function reply(harness: Harness, method: string, result: unknown, start = 0) {
  const request = await waitForHarnessRequest(harness, method, start);
  harness.send({ id: request.id, result });
}

const initialize = (harness: Harness) =>
  reply(harness, "initialize", {
    userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)`,
  });
const capabilities = (harness: Harness) =>
  reply(harness, "modelProvider/capabilities/read", { imageGeneration: false, webSearch: true });
const requirements = (harness: Harness, start = 0) =>
  reply(harness, "configRequirements/read", { requirements: null }, start);
async function startTurn(harness: Harness, threadId = "thread-1", turnId = "turn-1", start = 0) {
  await reply(harness, "thread/start", threadStartResult(threadId), start);
  await reply(harness, "turn/start", turnStartResult(turnId), start);
}

function completeTurn(harness: Harness, threadId = "thread-1", turnId = "turn-1") {
  harness.send({
    method: "turn/completed",
    params: { threadId, turnId, turn: { id: turnId, status: "completed", items: [] } },
  });
}

function commandEvent(
  harness: Harness,
  phase: "started" | "completed",
  id: string,
  command: string,
  output?: string,
  threadId = "thread-1",
  turnId = "turn-1",
) {
  const event = itemNotification(`item/${phase}`, {
    id,
    type: "commandExecution",
    command,
    status: phase === "started" ? "inProgress" : "completed",
    ...(output === undefined ? {} : { aggregatedOutput: output, exitCode: 0 }),
  });
  harness.send({ ...event, params: { ...event.params, threadId, turnId } });
}

function scenarioParams(name: string, sessionKey?: string) {
  return createParams(
    path.join(tempDir, `${name}.jsonl`),
    path.join(tempDir, `${name}-workspace`),
    sessionKey,
  );
}

async function incognitoParams(name: string) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  await seedRunSessionOwnerForTest("session-1", sessionKey);
  const params = scenarioParams(name, sessionKey);
  params.disableTools = false;
  return params;
}

const requestMethods = (harness: Harness) =>
  harness.writes.map((write) => (JSON.parse(write) as { method: string }).method);
const requestPrelude = ["config/read", "configRequirements/read", "account/read"];

setupRunAttemptTestHooks();

describe("Codex app-server main thread cleanup", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    clearRuntimeConfigSnapshot();
  });

  it("keeps alternating conversations subscribed after one fails on their shared Codex client", async () => {
    const workspaceDir = path.join(tempDir, "shared-workspace");
    const sessionFiles = {
      a: path.join(tempDir, "session-a.jsonl"),
      b: path.join(tempDir, "session-b.jsonl"),
    };
    for (const label of ["a", "b"]) {
      await seedRunSessionOwnerForTest(`session-${label}`, `agent:main:session-${label}`);
    }
    const harness = createInferenceReadyClientHarness();
    const clientStarted = createDeferred<void>();
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      clientStarted.resolve();
      return harness.client;
    });

    for (const [index, label] of (["a", "b", "a", "b"] as const).entries()) {
      const sessionKey = `agent:main:session-${label}`;
      const params = createParams(sessionFiles[label], workspaceDir, sessionKey);
      params.sessionId = `session-${label}`;
      params.runId = `run-${index + 1}`;
      params.provider = "openai";
      // Ordinary Codex conversations retain their native tool surface; a
      // disableTools turn is intentionally isolated on a temporary thread.
      params.disableTools = false;
      const requestStart = harness.writes.length;
      const run = runCodexAppServerAttempt(params);
      if (index === 0) {
        await clientStarted.promise;
        await initialize(harness);
      }
      await requirements(harness, requestStart);
      const threadId = `thread-${label}`;
      if (index < 2) {
        const start = await waitForHarnessRequest(harness, "thread/start", requestStart);
        harness.send({ id: start.id, result: threadStartResult(threadId, { cwd: workspaceDir }) });
      }
      const turn = await waitForHarnessRequest(harness, "turn/start", requestStart);
      const turnId = `turn-${index + 1}`;
      harness.send({ id: turn.id, result: turnStartResult(turnId) });
      harness.send({
        method: "turn/completed",
        params: {
          threadId,
          turnId,
          turn: {
            id: turnId,
            status: index === 0 ? "failed" : "completed",
            items: [],
            ...(index === 0 ? { error: { message: "Native turn failed" } } : {}),
          },
        },
      });
      expect(readAttemptTerminal(await run).aborted).toBe(false);
    }

    const userRequestMethods = () =>
      harness.writes
        .map((write) => (JSON.parse(write) as { method: string }).method)
        .filter((method) => !["initialize", "initialized", "skills/list"].includes(method));
    expect(userRequestMethods()).toEqual([
      ...requestPrelude,
      "thread/start",
      "turn/start",
      ...requestPrelude,
      "thread/start",
      "turn/start",
      ...requestPrelude,
      "turn/start",
      ...requestPrelude,
      "turn/start",
    ]);
    await expect(readCodexAppServerBinding(sessionFiles.a)).resolves.toMatchObject({
      threadId: "thread-a",
    });
    await expect(readCodexAppServerBinding(sessionFiles.b)).resolves.toMatchObject({
      threadId: "thread-b",
    });

    const retirementStart = harness.writes.length;
    const retirement = retireCodexAppServerSessionGeneration({
      bindingStore: testCodexAppServerBindingStore,
      identity: sessionBindingIdentity({
        agentId: "main",
        sessionId: "session-a",
        sessionKey: "agent:main:session-a",
      }),
      mode: "reset",
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe", retirementStart);
    expect(unsubscribe.params).toEqual({ threadId: "thread-a" });
    harness.send({ id: unsubscribe.id, result: {} });
    await expect(retirement).resolves.toBe("applied");

    const siblingParams = createParams(sessionFiles.b, workspaceDir, "agent:main:session-b");
    siblingParams.sessionId = "session-b";
    siblingParams.runId = "run-surviving-sibling";
    siblingParams.provider = "openai";
    siblingParams.disableTools = false;
    const siblingRequestStart = harness.writes.length;
    const siblingRun = runCodexAppServerAttempt(siblingParams);
    await requirements(harness, siblingRequestStart);
    const siblingTurn = await waitForHarnessRequest(harness, "turn/start", siblingRequestStart);
    harness.send({ id: siblingTurn.id, result: turnStartResult("turn-5") });
    completeTurn(harness, "thread-b", "turn-5");
    expect(readAttemptTerminal(await siblingRun).aborted).toBe(false);
    expect(userRequestMethods().slice(-5)).toEqual([
      "thread/unsubscribe",
      ...requestPrelude,
      "turn/start",
    ]);
  });

  it("preserves a quiet long-running native tool while a distinct shared-client turn completes", async () => {
    const physical = createInferenceReadyClientHarness();
    const startClient = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(physical.client);
    const firstParams = scenarioParams("concurrent-first", "agent:main:telegram:topic:first");
    const secondParams = scenarioParams("concurrent-second", "agent:main:telegram:topic:second");
    firstParams.sessionId = "session-first";
    secondParams.sessionId = "session-second";
    await seedRunSessionOwnerForTest(firstParams.sessionId, firstParams.sessionKey!);
    await seedRunSessionOwnerForTest(secondParams.sessionId, secondParams.sessionKey!);
    firstParams.timeoutMs = 60_000;
    secondParams.timeoutMs = 60_000;

    const firstRun = runCodexAppServerAttempt(firstParams);
    await initialize(physical);
    await startTurn(physical, "thread-1", "turn-1");

    commandEvent(physical, "started", "cmd-silent", "sleep 1");

    const secondRequestStart = physical.writes.length;
    const secondRun = runCodexAppServerAttempt(secondParams);
    await startTurn(physical, "thread-2", "turn-2", secondRequestStart);
    commandEvent(
      physical,
      "started",
      "cmd-ticking",
      "printf tick",
      undefined,
      "thread-2",
      "turn-2",
    );
    physical.send({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "cmd-ticking",
        delta: "tick\n",
      },
    });
    commandEvent(
      physical,
      "completed",
      "cmd-ticking",
      "printf tick",
      "tick\n",
      "thread-2",
      "turn-2",
    );
    completeTurn(physical, "thread-2", "turn-2");

    const secondResult = await secondRun;
    let firstSettled = false;
    void firstRun.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(firstSettled).toBe(false);

    commandEvent(physical, "completed", "cmd-silent", "sleep 1", "silent command finished\n");
    physical.send(turnCompleted({ id: "turn-1", status: "completed" }));

    const firstResult = await firstRun;
    expect(startClient).toHaveBeenCalledOnce();
    expect(readAttemptTerminal(firstResult)).toMatchObject({ timedOut: false, promptError: null });
    expect(readAttemptTerminal(secondResult)).toMatchObject({ timedOut: false, promptError: null });
    expect(JSON.stringify(firstResult.messagesSnapshot)).toContain("silent command finished");
    expect(JSON.stringify(firstResult.messagesSnapshot)).not.toContain("matching tool.result");
    expect(JSON.stringify(secondResult.messagesSnapshot)).toContain("tick");
    expect(JSON.stringify(secondResult.messagesSnapshot)).not.toContain("cmd-silent");
  });

  it("keeps native continuation active after a child result until the parent completes", async () => {
    const physical = createInferenceReadyClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(physical.client);
    const params = scenarioParams("child-result");
    params.disableTools = false;
    params.provider = "openai";
    params.timeoutMs = 60 * 60_000;
    const progress = vi.fn();
    params.onRunProgress = progress;
    const run = runCodexAppServerAttempt(params);
    try {
      await initialize(physical);
      await requirements(physical);
      await startTurn(physical);
      await yieldEventLoop();

      vi.useFakeTimers();
      for (const item of [
        {
          type: "custom_tool_call_output",
          id: "tool-output",
          call_id: "tool-call",
          output: [{ type: "input_text", text: "Tool completed." }],
        },
        {
          type: "agent_message",
          id: "child-result",
          author: "/root/evidence",
          recipient: "/root",
          content: [
            {
              type: "input_text",
              text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/evidence\nPayload:\nEvidence collected.",
            },
          ],
        },
      ]) {
        physical.send(rawItemCompleted(item));
      }
      await vi.waitFor(() => {
        expect(
          progress.mock.calls.filter(
            ([event]) => event.reason === "notification:rawResponseItem/completed",
          ),
        ).toHaveLength(2);
      });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(requestMethods(physical)).not.toContain("turn/interrupt");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(requestMethods(physical)).not.toContain("turn/interrupt");
      completeTurn(physical, "thread-1", "turn-1");
      vi.useRealTimers();
      expect(readAttemptTerminal(await run)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
    } finally {
      vi.useRealTimers();
      physical.client.close();
      await run.catch(() => undefined);
    }
  });

  it("keeps an incognito thread subscribed for live in-process reuse", async () => {
    const params = await incognitoParams("live-thread");
    const { sessionFile, sessionKey } = params;
    const harness = createInferenceReadyClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const run = runCodexAppServerAttempt(params);
    await initialize(harness);
    await capabilities(harness);
    await requirements(harness);
    const start = await waitForHarnessRequest(harness, "thread/start");
    expect(start.params).toEqual(expect.objectContaining({ ephemeral: true }));
    harness.send({ id: start.id, result: threadStartResult() });
    const turn = await waitForHarnessRequest(harness, "turn/start");
    harness.send({ id: turn.id, result: turnStartResult() });
    completeTurn(harness, "thread-1", "turn-1");

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      clientId: harness.client.getInstanceId(),
    });

    const requestStart = harness.writes.length;
    const retirement = retireCodexAppServerSessionGeneration({
      bindingStore: testCodexAppServerBindingStore,
      identity: sessionBindingIdentity({ agentId: "main", sessionId: "session-1", sessionKey }),
      mode: "retire",
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe", requestStart);
    expect(unsubscribe.params).toEqual({ threadId: "thread-1" });
    harness.send({ id: unsubscribe.id, result: {} });
    await expect(retirement).resolves.toBe("applied");
  });

  it.each(
    [
      { reason: "fails", error: new Error("turn start exploded") },
      {
        reason: "is cancelled before its request is written",
        error: Object.assign(new Error("turn/start aborted"), {
          code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
          mayHaveWritten: false,
        }),
      },
    ].flatMap(({ reason, error }) =>
      ["current", "successor"].map((owner) => ({ reason, error, owner })),
    ),
  )(
    "settles rejected incognito startup for the $owner physical owner when turn start $reason",
    async ({ error, owner }) => {
      const params = await incognitoParams("failed-turn");
      const { sessionFile } = params;
      const identity = sessionBindingIdentity(params);
      const releaseLease = vi.spyOn(sharedClient, "releaseLeasedSharedCodexAppServerClient");
      const request = vi.fn(async (method: string) => {
        if (method === "modelProvider/capabilities/read") {
          return { imageGeneration: false, webSearch: true };
        }
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          if (owner === "successor") {
            const binding = testCodexAppServerBindingStore.read(identity);
            if (!binding) {
              throw new Error("Expected the failed startup's native binding");
            }
            await testCodexAppServerBindingStore.mutate(identity, {
              kind: "set",
              binding: { ...binding, clientId: "successor-client" },
            });
          }
          throw error;
        }
        return {};
      });

      const client = {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      const clientFactory = multiplexedClientFactory(async () => client);

      await expect(runCodexAppServerAttempt(params, { clientFactory })).rejects.toThrow(
        error.message,
      );
      expect(withoutCodexSkillDiscovery(request.mock.calls.map(([method]) => method))).toEqual([
        "modelProvider/capabilities/read",
        "config/read",
        "configRequirements/read",
        "thread/start",
        "turn/start",
        ...(owner === "current" ? ["thread/unsubscribe"] : []),
      ]);
      if (owner === "current") {
        expect(request).toHaveBeenCalledWith(
          "thread/unsubscribe",
          { threadId: "thread-1" },
          { timeoutMs: 5_000, withCurrent: expect.any(Function) },
        );
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      } else {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-1",
          clientId: "successor-client",
        });
      }
      const route = getCodexAppServerTurnRouter(client).reserveThread({ threadId: "thread-1" });
      route.release();
      expect(releaseLease).toHaveBeenCalledWith(client);
    },
  );

  it.each([
    { label: "confirms", interruptFails: false },
    { label: "cannot confirm", interruptFails: true },
  ])(
    "$label an indeterminate native turn before releasing its thread",
    async ({ interruptFails }) => {
      const harness = createInferenceReadyClientHarness();
      const abort = new AbortController();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

      const params = scenarioParams("cancelled-start");
      params.abortSignal = abort.signal;
      const run = runCodexAppServerAttempt(params);
      const failure = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      await initialize(harness);
      const threadStart = await waitForHarnessRequest(harness, "thread/start");
      harness.send({ id: threadStart.id, result: threadStartResult() });
      const turnStart = await waitForHarnessRequest(harness, "turn/start");

      abort.abort("cancelled");
      const interrupt = await waitForHarnessRequest(harness, "turn/interrupt");
      expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "" },
      });
      harness.send({ id: turnStart.id, result: turnStartResult() });
      harness.send(
        interruptFails
          ? { id: interrupt.id, error: { code: -32_000, message: "startup interrupt failed" } }
          : { id: interrupt.id, result: {} },
      );
      if (!interruptFails) {
        const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
        expect(unsubscribe.params).toEqual({ threadId: "thread-1" });
        harness.send({ id: unsubscribe.id, result: {} });
      }
      await expect(failure).resolves.toMatchObject({
        message: "turn/start aborted: cancelled",
        cause: "cancelled",
        reason: "aborted",
        mayHaveWritten: true,
      });
      expect(requestMethods(harness)).toEqual([
        "initialize",
        "initialized",
        "skills/list",
        "config/read",
        "account/read",
        "thread/start",
        "turn/start",
        "turn/interrupt",
        ...(interruptFails ? [] : ["thread/unsubscribe"]),
      ]);
      expect(harness.stdinDestroyed).toBe(interruptFails);
    },
  );

  it("preserves startup cancellation when unsafe client retirement rejects", async () => {
    const startupError = Object.assign(new Error("turn/start aborted"), {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      mayHaveWritten: true,
    });
    const close = vi.fn();
    const closeAndWait = vi.fn(async () => {
      throw new Error("client retirement failed");
    });
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw startupError;
      }
      if (method === "turn/interrupt") {
        throw new Error("startup interrupt failed");
      }
      throw new Error(`unexpected cleanup request: ${method}`);
    });
    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        close,
        closeAndWait,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    await expect(
      runCodexAppServerAttempt(scenarioParams("retirement-failure"), { clientFactory }),
    ).rejects.toBe(startupError);
    expect(withoutCodexSkillDiscovery(request.mock.calls.map(([method]) => method))).toEqual([
      "config/read",
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ]);
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "joins native terminal cleanup before releasing cancellation (RPC fails: %s)",
    async (terminationFails) => {
      const params = await incognitoParams("cancelled-turn");
      const harness = createInferenceReadyClientHarness();
      const abort = new AbortController();
      const close = vi.spyOn(harness.client, "close");
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

      params.abortSignal = abort.signal;
      let settled = false;
      const run = runCodexAppServerAttempt(params).finally(() => {
        settled = true;
      });
      await initialize(harness);
      await capabilities(harness);
      await requirements(harness);
      await startTurn(harness);
      await yieldEventLoop();

      abort.abort("cancelled");
      const interrupt = await waitForHarnessRequest(harness, "turn/interrupt");
      expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      });
      harness.send({ id: interrupt.id, result: {} });
      await yieldEventLoop();
      expect(settled).toBe(false);
      expect(requestMethods(harness)).not.toContain("thread/unsubscribe");

      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-unrelated", status: "interrupted", items: [] },
        },
      });
      await yieldEventLoop();
      expect(settled).toBe(false);

      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", items: [] },
        },
      });
      const list = await waitForHarnessRequest(harness, "thread/backgroundTerminals/list");
      expect(list.params).toEqual({ threadId: "thread-1" });
      harness.send({ id: list.id, result: { data: [{ processId: "42" }], nextCursor: null } });
      const terminate = await waitForHarnessRequest(
        harness,
        "thread/backgroundTerminals/terminate",
      );
      expect(terminate.params).toEqual({ threadId: "thread-1", processId: "42" });
      await yieldEventLoop();
      expect(settled).toBe(false);
      expect(requestMethods(harness)).not.toContain("thread/unsubscribe");
      const confirmationStart = harness.writes.length;
      const rejected = terminationFails
        ? expect(run).rejects.toThrow("Codex background-terminal cleanup failed")
        : undefined;
      if (terminationFails) {
        harness.send({
          id: terminate.id,
          error: { code: -32_603, message: "terminal service unavailable" },
        });
      } else {
        harness.send({ id: terminate.id, result: { terminated: true } });
        const confirmation = await waitForHarnessRequest(
          harness,
          "thread/backgroundTerminals/list",
          confirmationStart,
        );
        harness.send({ id: confirmation.id, result: { data: [], nextCursor: null } });
      }
      const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
      expect(unsubscribe.params).toEqual({ threadId: "thread-1" });
      expect(settled).toBe(false);
      harness.send({ id: unsubscribe.id, result: {} });
      if (rejected) {
        await rejected;
      } else {
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true, timedOut: false });
      }
      expect(
        harness.writes.filter((entry) => JSON.parse(entry).method === "thread/unsubscribe"),
      ).toHaveLength(1);
      expect(close).not.toHaveBeenCalled();
      expect(harness.stdinDestroyed).toBe(false);
    },
  );

  it("rejects late cancellation after failed finalization enters cleanup", async () => {
    const harness = createInferenceReadyClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const abort = new AbortController();
    const params = scenarioParams("failed-finalization");
    params.abortSignal = abort.signal;
    const projectionError = new Error("terminal projection failed");
    const run = runCodexAppServerAttempt(params);
    const failure = run.catch((error: unknown) => error);
    await initialize(harness);
    await startTurn(harness);
    vi.spyOn(CodexAppServerEventProjector.prototype, "buildResult").mockImplementationOnce(() => {
      throw projectionError;
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
    abort.abort("cancelled during cleanup");
    const methods = requestMethods(harness);
    harness.send({ id: unsubscribe.id, result: {} });
    expect(methods).not.toContain("turn/interrupt");
    expect(await failure).toBe(projectionError);
  });

  it("gracefully retires a shared Codex client when a failed turn cannot unsubscribe", async () => {
    const params = await incognitoParams("failed-unsubscribe");
    const { sessionFile, workspaceDir, sessionKey } = params;
    const contaminated = createInferenceReadyClientHarness();
    const replacement = createInferenceReadyClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(contaminated.client)
      .mockResolvedValueOnce(replacement.client);

    const failedRun = runCodexAppServerAttempt(params);
    const observedFailure = failedRun.then(
      () => undefined,
      (error: unknown) => error,
    );
    await initialize(contaminated);
    await capabilities(contaminated);
    await requirements(contaminated);
    const threadStart = await waitForHarnessRequest(contaminated, "thread/start");
    contaminated.send({ id: threadStart.id, result: threadStartResult() });

    const turnStart = await waitForHarnessRequest(contaminated, "turn/start");
    const releaseSiblingLease = retainSharedCodexAppServerClientIfCurrent(contaminated.client);
    if (!releaseSiblingLease) {
      throw new Error("Codex harness did not acquire the real shared client");
    }
    contaminated.send({
      id: turnStart.id,
      error: { code: -32000, message: "turn start exploded" },
    });
    const unsubscribe = await waitForHarnessRequest(contaminated, "thread/unsubscribe");
    contaminated.send({
      id: unsubscribe.id,
      error: { code: -32000, message: "thread unsubscribe failed" },
    });

    const turnStartError = await observedFailure;
    expect(turnStartError).toBeInstanceOf(Error);
    expect(turnStartError).toMatchObject({ message: "turn start exploded" });
    expect(contaminated.stdinDestroyed).toBe(false);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();

    const replacementParams = createParams(sessionFile, workspaceDir, sessionKey);
    replacementParams.disableTools = false;
    const replacementRun = runCodexAppServerAttempt(replacementParams);
    await initialize(replacement);
    await capabilities(replacement);
    await requirements(replacement);
    await startTurn(replacement, "thread-2", "turn-2");
    completeTurn(replacement, "thread-2", "turn-2");

    expect(readAttemptTerminal(await replacementRun)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(startClient).toHaveBeenCalledTimes(2);
    expect(contaminated.stdinDestroyed).toBe(false);
    releaseSiblingLease();
    await vi.waitFor(() => expect(contaminated.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  });
});
