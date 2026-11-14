import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { setActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { createDynamicToolCall } from "./dynamic-tools.test-support.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import type { JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  fastWait,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
import { activeRunRegistrationMocks } from "./run-attempt.steering.test-helpers.js";
import {
  createSteeringParams,
  createSteeringRecorder,
} from "./run-attempt.steering.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const { createSteeringRuntimeMock } = await import("./run-attempt.steering.test-helpers.js");
  return createSteeringRuntimeMock(
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>(),
  );
});

setupRunAttemptTestHooks();

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

type RegisteredRun = Parameters<typeof setActiveEmbeddedRun>[1];
function registeredRun(sessionId: string) {
  return activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
    (call) => call[0] === sessionId,
  )?.[1] as RegisteredRun | undefined;
}

async function waitForRegisteredRun(sessionId: string) {
  await vi.waitFor(() => expect(registeredRun(sessionId)).toBeDefined(), fastWait);
  return registeredRun(sessionId)!;
}

type SteeringHarness = ReturnType<typeof createStartedThreadHarness>;
const steeringRequests = (harness: SteeringHarness) =>
  harness.requests.filter(({ method }) => method === "turn/steer");
const complete = (harness: SteeringHarness) =>
  harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

function assistantDelta(itemId: string, delta: string) {
  return {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId, delta },
  };
}

function expectSingleSteer(requests: Array<{ method: string; params?: unknown }>, text: string) {
  expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
    {
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: "openclaw:turn-1:steer:1",
      },
    },
  ]);
}

function steerClientId(request: { params?: unknown } | undefined) {
  const id = (request?.params as { clientUserMessageId?: string } | undefined)?.clientUserMessageId;
  if (!id) {
    throw new Error("turn/steer clientUserMessageId missing");
  }
  return id;
}

function assistantItem(
  method: "item/started" | "item/completed",
  id: string,
  text: string,
  phase = "final_answer",
) {
  return itemNotification(method, { type: "agentMessage", id, phase, text });
}

const consumedUser = (clientId: string, id = "steered-user-message") =>
  itemNotification("item/completed", { id, type: "userMessage", clientId });

it.each(["consumed", "unconfirmed"] as const)(
  "settles submitted steering before terminal tool interruption (%s)",
  async (outcome) => {
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    const params = createSteeringParams();
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const tool = createRuntimeDynamicTool("terminal_tool");
    tool.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Waiting for follow-up" }],
      details: { status: "yielded" },
    }));
    setCodexTestToolFactory(params, () => [tool]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    try {
      await run.waitForTurnAccepted();
      const handle = registeredRun(params.sessionId)!;
      const accepted = vi.fn();
      const settled = vi.fn();
      const delivery = handle.queueMessage("Keep this follow-up", {
        debounceMs: 0,
        waitForTranscriptCommit: true,
        onQueueAccepted: accepted,
        onQueueSettled: settled,
      });
      await harness.waitForMethod("turn/steer");
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      const clientId = steerClientId(
        harness.requests.find(({ method }) => method === "turn/steer"),
      );

      await expect(
        harness.handleServerRequest({
          id: "terminal-tool",
          method: "item/tool/call",
          params: createDynamicToolCall("terminal_tool", {}, "terminal-tool"),
        }),
      ).resolves.toMatchObject({ success: true });
      await yieldImmediate();
      expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      expect(settled).not.toHaveBeenCalled();

      if (outcome === "consumed") {
        await vi.advanceTimersByTimeAsync(10);
        await harness.notify(consumedUser(clientId));
        await expect(delivery).resolves.toBeUndefined();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(delivery).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
      }
      await harness.waitForMethod("turn/interrupt");
      await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" }));
      await run;
      expect(settled).toHaveBeenCalledOnce();
      expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(1);
      expect(harness.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(1);
    } finally {
      harness.close();
      await run;
      vi.useRealTimers();
    }
  },
);

it.each(["host tool", "local projection"] as const)(
  "keeps native execution ownership during %s after a long turn",
  async (work) => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const harness = createStartedThreadHarness();
    const params = createSteeringParams();
    params.timeoutMs = MAX_TIMER_TIMEOUT_MS;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const tool = createRuntimeDynamicTool("autoreview");
    tool.execute = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { content: [{ type: "text" as const, text: "Review complete" }], details: {} };
    });
    setCodexTestToolFactory(params, () => [tool]);
    if (work === "local projection") {
      params.verboseLevel = "full";
      params.onToolResult = async () => {
        started.resolve();
        await finish.promise;
      };
    }
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    let pending: Promise<unknown> | undefined;
    try {
      await run.waitForTurnAccepted();
      const handle = registeredRun(params.sessionId);
      await vi.waitFor(() => expect(handle?.ownsLiveness?.()).toBe(true), fastWait);
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      pending =
        work === "host tool"
          ? harness.handleServerRequest({
              id: "review-request",
              method: "item/tool/call",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                callId: "review-call",
                namespace: null,
                tool: "autoreview",
                arguments: {},
              },
            })
          : harness.notify(
              itemNotification("item/started", {
                type: "commandExecution",
                id: "native-command",
                command: "true",
                cwd: params.workspaceDir,
                status: "inProgress",
              }),
            );
      await started.promise;
      expect(handle?.ownsLiveness?.()).toBe(true);
      finish.resolve();
      await pending;
      if (work === "local projection") {
        await harness.notify(
          itemNotification("item/completed", {
            type: "commandExecution",
            id: "native-command",
            command: "true",
            cwd: params.workspaceDir,
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "",
          }),
        );
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
      expect(handle?.ownsLiveness?.()).toBe(false);
    } finally {
      finish.resolve();
      await pending;
      harness.close();
      await run;
    }
  },
);

it.each([
  { incognito: true, interruptFails: false, terminationFails: false },
  { incognito: false, interruptFails: true, terminationFails: false },
  { incognito: false, interruptFails: false, terminationFails: true },
])(
  "joins permission-change cleanup without cancelling the enclosing run (incognito: $incognito, interrupt failure: $interruptFails, terminal failure: $terminationFails)",
  async ({ incognito, interruptFails, terminationFails }) => {
    const terminalCleanup = createDeferred<void>();
    let terminalRunning = true;
    const { requests, waitForMethod } = createStartedThreadHarness(async (method) => {
      if (method === "turn/interrupt" && interruptFails) {
        throw new Error("native interrupt unavailable");
      }
      if (method === "thread/backgroundTerminals/list") {
        return { data: terminalRunning ? [{ processId: "42" }] : [], nextCursor: null };
      }
      if (method === "thread/backgroundTerminals/terminate") {
        await terminalCleanup.promise;
        if (terminationFails) {
          throw new Error("native terminal cleanup unavailable");
        }
        terminalRunning = false;
        return { terminated: true };
      }
      return undefined;
    });
    const params = createSteeringParams();
    if (incognito) {
      params.sessionKey = `agent:main:dashboard:incognito-${params.sessionId}`;
    }
    await seedRunSessionOwnerForTest(params.sessionId, params.sessionKey!);
    const onAttemptAbort = vi.fn();
    params.onAttemptAbort = onAttemptAbort;
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const application = createDeferred<boolean>();
    const permissionChange = {
      owner: {},
      baseExecOverrides: {},
      notice: "Permission change. Continue with updated permissions.",
      request: vi.fn(() => application.promise),
      applied: vi.fn(() => true),
      recordApplied: vi.fn(),
    };
    params.permissionChange = permissionChange;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const settled = vi.fn();
    void outcome.then(settled);
    await run.waitForTurnAccepted();
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      additionalContext: {
        openclaw_permission_change: { kind: "application", value: permissionChange.notice },
      },
    });
    const handle = registeredRun(params.sessionId);
    expect(handle).toBeDefined();
    try {
      expect(handle?.applyPermissionMode).toBeTypeOf("function");
      const revokeApprovals = vi.fn();
      const applied = handle!.applyPermissionMode!("full", revokeApprovals);
      const acknowledged = vi.fn();
      void applied.then(acknowledged);
      expect(revokeApprovals).toHaveBeenCalledOnce();
      if (!interruptFails) {
        await waitForMethod("thread/backgroundTerminals/terminate");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).not.toHaveBeenCalled();
        expect(requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
        terminalCleanup.resolve();
      }
      const error = await outcome;
      if (interruptFails) {
        expect(error).toMatchObject({
          message: "Permission change could not confirm the previous Codex turn stopped.",
        });
        expect(requests.some((request) => request.method.includes("backgroundTerminals"))).toBe(
          false,
        );
      } else if (terminationFails) {
        expect(error).toMatchObject({
          message:
            "Codex background-terminal cleanup failed; inspect the thread's running terminals before starting more work.",
        });
      } else {
        expect(error).toBeUndefined();
        expect(terminalRunning).toBe(false);
        expect(requests).toContainEqual({
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: "thread-1", processId: "42" },
        });
      }
      expect(acknowledged).not.toHaveBeenCalled();
      expect(onAttemptAbort).not.toHaveBeenCalled();
      expect(
        onAgentEvent.mock.calls.some(
          ([event]) =>
            event.stream === "lifecycle" &&
            ["end", "error", "finishing"].includes(event.data.phase),
        ),
      ).toBe(false);
      expect(permissionChange.request).toHaveBeenCalledWith("full");
      expect(requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      });
      expect(await readCodexAppServerBinding(params.sessionFile)).toMatchObject({
        threadId: "thread-1",
      });
      if (incognito) {
        expect(requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
      }
      const shouldApply = !interruptFails && !terminationFails;
      application.resolve(shouldApply);
      await expect(applied).resolves.toBe(shouldApply);
    } finally {
      terminalCleanup.resolve();
      handle?.abort();
      application.resolve(false);
      await outcome;
    }
  },
);

it("marks the active run aborted before asynchronous cleanup releases its handle", async () => {
  const { requests, waitForMethod } = createStartedThreadHarness();
  const params = createSteeringParams();
  activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
  activeRunRegistrationMocks.clearActiveEmbeddedRun.mockClear();

  const run = runCodexAppServerAttempt(params);
  await waitForMethod("turn/start");

  const handle = await waitForRegisteredRun(params.sessionId);
  expect(handle?.isAborted?.()).toBe(false);

  handle?.abort();
  expect(handle?.isAborted?.()).toBe(true);
  expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).not.toHaveBeenCalled();
  expect(readAttemptTerminal(await run).aborted).toBe(true);
  expect(queueActiveRunMessageForTest(params.sessionId, "after abort")).toBe(false);
  expect(requests).toContainEqual({
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" },
  });
});

it.each([
  ["completed-answer", false],
  ["unfinished-answer", true],
] as const)("persists pre-steer output (%s, second: %s)", async (completionId, secondSteer) => {
  const { requests, completeTurn, notify, waitForMethod } = createStartedThreadHarness();
  const params = createSteeringParams();
  const media = [{ path: "media://inbound/steered.csv", contentType: "text/csv" }];
  const attachmentNote = "Attachment file: /fixture/managed/steered.csv";
  const prepareAttachments = vi.fn<
    NonNullable<typeof params.hostCapabilities.prepareInputAttachments>
  >(async (request) => (request.turn ? attachmentNote : undefined));
  params.hostCapabilities = {
    ...params.hostCapabilities,
    prepareInputAttachments: prepareAttachments,
  };
  const storePath = path.join(tempDir, `${params.sessionId}.sqlite`);
  const sessionTarget = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath,
  };
  params.taskSuggestionDeliveryMode = "gateway";
  const preSteerVisible = createDeferred<void>();
  const onPartialReply = vi.fn<NonNullable<typeof params.onPartialReply>>((reply) => {
    if (reply.text === "PRE-STEER-INCOMPLETE") {
      preSteerVisible.resolve();
    }
  });
  params.onPartialReply = onPartialReply;
  params.sessionTarget = sessionTarget;
  await upsertSessionEntry({
    ...sessionTarget,
    entry: {
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      updatedAt: Date.now(),
    },
  });
  const createUserTurnRecorder = (text: string, idempotencyKey: string) => {
    let steerPersisted = false;
    return createSteeringRecorder(
      { role: "user", content: text, timestamp: 1 },
      async () => {
        if (steerPersisted) {
          return undefined;
        }
        steerPersisted = true;
        await appendSessionTranscriptMessageByIdentity({
          ...sessionTarget,
          message: {
            role: "user",
            content: text,
            timestamp: Date.now(),
            idempotencyKey,
          },
        });
        return undefined;
      },
      () => steerPersisted,
    );
  };
  const userTurnTranscriptRecorder = createUserTurnRecorder(
    "steer this active turn",
    `${params.runId}:steer:user`,
  );

  // Transcript ordering is independent of wall-clock filesystem latency.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const run = runCodexAppServerAttempt(params, {
    pluginConfig: { appServer: { mode: "yolo" } },
  });
  await run.waitForTurnAccepted();
  expect(requests.some((entry) => entry.method === "turn/start")).toBe(true);
  const queueAccepted = createDeferred<boolean>();
  const onQueueAccepted = vi.fn((accepted: boolean) => queueAccepted.resolve(accepted));
  await notify(
    assistantItem("item/completed", "pre-steer-commentary", "PRE-STEER-COMMENTARY", "commentary"),
  );
  for (const id of ["answer-a", "answer-b"]) {
    await notify(assistantItem("item/started", id, ""));
    await notify(assistantDelta(id, id));
    await notify(assistantItem("item/completed", id, id));
  }
  await notify(assistantItem("item/started", "unfinished-answer", ""));
  await notify(assistantDelta("unfinished-answer", "PRE-STEER-INCOMPLETE"));
  await preSteerVisible.promise;
  expect(onPartialReply).toHaveBeenCalledWith({
    text: "PRE-STEER-INCOMPLETE",
    delta: "PRE-STEER-INCOMPLETE",
  });

  expect(registeredRun(params.sessionId)).toMatchObject({
    taskSuggestionDeliveryMode: "gateway",
  });

  // This public queue returns immediate eligibility; the handle's delivery
  // promise stays pending until the matching item/completed notification below.
  expect(
    queueActiveRunMessageForTest(params.sessionId, "steer this active turn", {
      debounceMs: 0,
      isInboundUserMessage: true,
      media,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      taskSuggestionDeliveryMode: "gateway",
      waitForTranscriptCommit: true,
      onQueueAccepted,
      userTurnTranscriptRecorder,
    }),
  ).toBe(true);
  await waitForMethod("turn/steer");
  expect(requests.map((entry) => entry.method)).toContain("turn/steer");
  const steer = requests.find((entry) => entry.method === "turn/steer");
  const persistedBeforeNativeSubmission = userTurnTranscriptRecorder.hasPersisted();
  const clientUserMessageId = steerClientId(steer);
  expect(await queueAccepted.promise).toBe(true);
  expect(onQueueAccepted).toHaveBeenCalledWith(true);

  await notify(consumedUser(clientUserMessageId));
  const readTextRows = async () =>
    (await readSessionTranscriptEvents(sessionTarget)).flatMap((event) => {
      const message = (
        event as {
          message?: {
            role: string;
            content: string | Array<{ type: string; text?: string }>;
            __openclaw?: { mirrorIdentity?: string };
            provenance?: JsonObject;
          };
        }
      ).message;
      if (!message || (message.role !== "assistant" && message.role !== "user")) {
        return [];
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      return text
        ? [
            {
              role: message.role,
              text,
              mirrorIdentity: message["__openclaw"]?.mirrorIdentity,
              ...(message.provenance ? { provenance: message.provenance } : {}),
            },
          ]
        : [];
    });
  const prefix = await readTextRows();
  await notify(
    assistantItem("item/completed", completionId, "PRE-STEER-INCOMPLETE POST-STEER-CONTINUATION"),
  );
  if (secondSteer) {
    const secondAccepted = createDeferred<boolean>();
    expect(
      queueActiveRunMessageForTest(params.sessionId, "steer again", {
        debounceMs: 0,
        isInboundUserMessage: true,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        waitForTranscriptCommit: true,
        onQueueAccepted: secondAccepted.resolve,
        userTurnTranscriptRecorder: createUserTurnRecorder(
          "steer again",
          `${params.runId}:second-steer:user`,
        ),
      }),
    ).toBe(true);
    expect(await secondAccepted.promise).toBe(true);
    const secondRequest = requests.findLast((entry) => entry.method === "turn/steer")?.params as {
      clientUserMessageId: string;
    };
    await notify(consumedUser(secondRequest.clientUserMessageId, "second-steered-user-message"));
  }
  await notify(assistantItem("item/completed", "final-answer", "Steering completed."));
  await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const completedRun = await run;

  expect(readAttemptTerminal(completedRun)).toMatchObject({ aborted: false, timedOut: false });
  expect(persistedBeforeNativeSubmission).toBe(true);
  expect(steer?.params).toMatchObject({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: `steer this active turn\n\n${attachmentNote}` }],
  });
  expect(prepareAttachments).toHaveBeenCalledWith(
    expect.objectContaining({
      placement: "local-host",
      turn: expect.objectContaining({ media }),
    }),
  );
  expect
    .soft(prefix.map(({ text }) => text))
    .toEqual([
      params.prompt,
      "PRE-STEER-COMMENTARY",
      "answer-a",
      "answer-b",
      "PRE-STEER-INCOMPLETE",
      "steer this active turn",
    ]);
  const finishedRows = await readTextRows();
  expect.soft(finishedRows.slice(0, 6)).toEqual(prefix);
  expect
    .soft(
      finishedRows
        .slice(6)
        .map(({ text }) => text)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .toBe(`POST-STEER-CONTINUATION ${secondSteer ? "steer again " : ""}Steering completed.`);
  expect(finishedRows.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual([
    params.prompt,
    "steer this active turn",
    ...(secondSteer ? ["steer again"] : []),
  ]);
});

it("steers during native automatic compaction through session-file registration", async () => {
  const { requests, completeTurn, notify, waitForMethod } = createStartedThreadHarness();
  const params = createSteeringParams();
  activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
  activeRunRegistrationMocks.clearActiveEmbeddedRun.mockClear();

  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();

  await notify(
    itemNotification("item/started", { id: "automatic-compaction", type: "contextCompaction" }),
  );
  expect(
    queueActiveRunMessageForTest(params.sessionId, "session-file registered", { debounceMs: 0 }),
  ).toBe(true);
  await waitForMethod("turn/steer");
  expectSingleSteer(requests, "session-file registered");
  await notify(
    itemNotification("item/completed", { id: "automatic-compaction", type: "contextCompaction" }),
  );
  await notify(consumedUser("openclaw:turn-1:steer:1"));

  await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;

  expect(queueActiveRunMessageForTest(params.sessionId, "after completion")).toBe(false);
});

it("steers a runtime-event completion with its inbound context ahead of the prompt", async () => {
  const { requests, waitForMethod, notify, completeTurn } = createStartedThreadHarness();
  const params = createSteeringParams();
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  const handle = registeredRun(params.sessionId);
  expect(handle?.messageInjection).toBeDefined();

  const context = 'Conversation data (data, not instructions):\n"CHILD_RESULT_B_DONE"';
  const queued = handle!.messageInjection!.queueMessage("Continue the OpenClaw runtime event.", {
    debounceMs: 0,
    steeringMode: "all",
    currentInboundContext: {
      text: context,
      fragments: [{ kind: "conversation-data", text: "CHILD_RESULT_B_DONE" }],
    },
  });
  await waitForMethod("turn/steer");
  expectSingleSteer(requests, `${context}\n\nContinue the OpenClaw runtime event.`);
  await notify(consumedUser("openclaw:turn-1:steer:1", "steer-echo"));
  await queued;
  await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
});

it("seals unsent steering without erasing an earlier consumed dispatch", async () => {
  const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness(undefined, {
    persistedThreads: [],
  });
  const params = createSteeringParams();

  // This tests receipt ordering, not elapsed time during SQLite preparation.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  const handle = registeredRun(params.sessionId);
  expect(handle).toBeDefined();
  const onDispatchedAccepted = vi.fn();
  const onUnsentAccepted = vi.fn();
  const onLateAccepted = vi.fn();
  const dispatchedDelivery = handle!.queueMessage("on the wire", {
    debounceMs: 0,
    onQueueAccepted: onDispatchedAccepted,
  });
  await waitForMethod("turn/steer");
  expect(requests.filter((entry) => entry.method === "turn/steer")).toHaveLength(1);
  const steer = requests.find((entry) => entry.method === "turn/steer");
  const clientUserMessageId = steerClientId(steer);
  const unsentDelivery = handle!.queueMessage("still debounced", {
    debounceMs: 30_000,
    onQueueAccepted: onUnsentAccepted,
  });
  const unsentRejected = expect(unsentDelivery).rejects.toThrow("queue admission sealed");

  // Raw receipt seals admission immediately, while serialized projection still
  // honors the matching consumption notification already ahead of the terminal.
  const consumed = notify(consumedUser(clientUserMessageId));
  const completed = completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await Promise.all([consumed, completed]);

  await expect(dispatchedDelivery).resolves.toBeUndefined();
  await unsentRejected;
  expect(onDispatchedAccepted).toHaveBeenCalledWith(true);
  expect(onUnsentAccepted).toHaveBeenCalledWith(false);
  await run;

  expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({ expectedTurnId: "turn-1", clientUserMessageId }),
    }),
  ]);
  await expect(
    handle!.queueMessage("too late", { debounceMs: 0, onQueueAccepted: onLateAccepted }),
  ).rejects.toThrow("steering queue cancelled");
  expect(onLateAccepted).toHaveBeenCalledWith(false);
});

it.each(["cancellation fails", "keep pending question"] as const)(
  "steers a human image when %s",
  async (mode) => {
    const harness = createStartedThreadHarness();
    const params = createSteeringParams();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await run.waitForTurnAccepted();
    const handle = await waitForRegisteredRun(params.sessionId);
    const cancelQuestion = activeRunRegistrationMocks.cancelPendingAgentQuestionForSession;
    const cancellations = cancelQuestion.mock.calls.length;
    if (mode === "cancellation fails") {
      activeRunRegistrationMocks.cancelQuestionError = new Error("gateway unavailable");
    }
    const accepted = vi.fn();
    const delivery = handle.queueMessage("inspect this", {
      debounceMs: 0,
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      isInboundUserMessage: true,
      ...(mode === "keep pending question" ? { allowPendingUserInputAnswer: false } : {}),
      onQueueAccepted: accepted,
    });
    try {
      await harness.waitForMethod("turn/steer");
      await harness.notify(consumedUser(steerClientId(steeringRequests(harness).at(-1))));
      await delivery;
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      if (mode === "keep pending question") {
        expect(cancelQuestion).toHaveBeenCalledTimes(cancellations);
      }
      expect(steeringRequests(harness)).toHaveLength(1);
    } finally {
      await complete(harness);
      await run;
    }
  },
);
