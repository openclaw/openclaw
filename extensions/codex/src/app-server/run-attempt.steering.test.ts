import path from "node:path";
import type { setActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import type { JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createStartedThreadHarness,
  fastWait,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
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

function registeredCleanup(sessionId: string) {
  const index = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLastIndex(
    (call) => call[0] === sessionId,
  );
  const cleanup = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.results[index]?.value;
  expect(cleanup).toBeTypeOf("function");
  return cleanup;
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
  const cleanup = registeredCleanup(params.sessionId);
  expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
    params.sessionId,
    handle,
    params.sessionKey,
    params.sessionFile,
    undefined,
    cleanup,
  );
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
    await notify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: id, delta: id },
    });
    await notify(assistantItem("item/completed", id, id));
  }
  await notify(assistantItem("item/started", "unfinished-answer", ""));
  await notify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "unfinished-answer",
      delta: "PRE-STEER-INCOMPLETE",
    },
  });
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

it("still steers an image when gateway question cancellation fails", async () => {
  const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
  const params = createSteeringParams();
  const run = runCodexAppServerAttempt(params, {
    pluginConfig: { appServer: { mode: "yolo" } },
  });
  await waitForMethod("turn/start");
  const handle = await waitForRegisteredRun(params.sessionId);

  activeRunRegistrationMocks.cancelQuestionError = new Error("gateway unavailable");
  const delivered = handle!.queueMessage("inspect this", {
    debounceMs: 0,
    images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    isInboundUserMessage: true,
  });
  await vi.waitFor(
    () => expect(requests.map((entry) => entry.method)).toContain("turn/steer"),
    fastWait,
  );
  const steer = requests.findLast((entry) => entry.method === "turn/steer");
  const clientUserMessageId = steerClientId(steer);
  await notify(consumedUser(clientUserMessageId));
  await delivered;
  await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
});

it("steers during native automatic compaction through session-file registration", async () => {
  const { requests, completeTurn, notify, waitForMethod } = createStartedThreadHarness();
  const params = createSteeringParams();
  activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
  activeRunRegistrationMocks.clearActiveEmbeddedRun.mockClear();

  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();

  expect(activeRunRegistrationMocks.setActiveEmbeddedRun).toHaveBeenCalledWith(
    params.sessionId,
    expect.anything(),
    params.sessionKey,
    params.sessionFile,
    "main",
  );
  const cleanup = registeredCleanup(params.sessionId);

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

  expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
    params.sessionId,
    expect.anything(),
    params.sessionKey,
    params.sessionFile,
    undefined,
    cleanup,
  );
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

it("steers a human image control without cancelling the pending Codex question", async () => {
  const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
  const params = createSteeringParams();
  const run = runCodexAppServerAttempt(params, {
    pluginConfig: { appServer: { mode: "yolo" } },
  });
  await run.waitForTurnAccepted();
  const handle = registeredRun(params.sessionId);
  if (!handle) {
    throw new Error("Expected the actual published Codex backend");
  }
  const cancellations =
    activeRunRegistrationMocks.cancelPendingAgentQuestionForSession.mock.calls.length;
  const accepted = vi.fn();
  const delivery = handle.queueMessage("inspect this without answering the question", {
    debounceMs: 0,
    images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    isInboundUserMessage: true,
    allowPendingUserInputAnswer: false,
    onQueueAccepted: accepted,
  });
  try {
    await waitForMethod("turn/steer");
    const steer = requests.findLast((entry) => entry.method === "turn/steer");
    await notify(consumedUser(steerClientId(steer)));
    await delivery;
    expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
    expect(activeRunRegistrationMocks.cancelPendingAgentQuestionForSession).toHaveBeenCalledTimes(
      cancellations,
    );
    expect(requests.filter((entry) => entry.method === "turn/steer")).toHaveLength(1);
  } finally {
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  }
});
