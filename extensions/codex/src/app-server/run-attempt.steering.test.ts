// Codex tests cover run attempt.steering plugin behavior.
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexSteeringQueueOptions } from "./attempt-steering.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import type { JsonObject } from "./protocol.js";
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
  waitAndQueueActiveRunMessage,
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

describe("runCodexAppServerAttempt steering", () => {
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
      let acknowledgeApplied: ((applied: boolean) => void) | undefined;
      const application = new Promise<boolean>((resolve) => {
        acknowledgeApplied = resolve;
      });
      const permissionChange = {
        owner: {},
        baseExecOverrides: {},
        notice: "Permission change. Continue with updated permissions.",
        request: vi.fn(() => application),
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
      const handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as
        | {
            abort: () => void;
            applyPermissionMode?: (mode: "full", revokeApprovals: () => void) => Promise<boolean>;
          }
        | undefined;
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
        acknowledgeApplied?.(shouldApply);
        await expect(applied).resolves.toBe(shouldApply);
      } finally {
        terminalCleanup.resolve();
        handle?.abort();
        acknowledgeApplied?.(false);
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

    let handle: { abort: () => void; isAborted?: () => boolean } | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);
    expect(handle?.isAborted?.()).toBe(false);

    handle?.abort();
    expect(handle?.isAborted?.()).toBe(true);
    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).not.toHaveBeenCalled();
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      handle,
      params.sessionKey,
      params.sessionFile,
    );
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it.each([
    ...["commandExecution"].map((barrierType) => ({
      name: `Gateway steering across a ${barrierType} barrier`,
      barrierType,
      isInboundUserMessage: true,
      provenance: undefined,
      unfinishedAnswer: false,
      completionId: "unfinished-answer",
      secondSteer: false,
    })),
    ...[
      { completionId: "unfinished-answer", secondSteer: false },
      { completionId: "completed-answer", secondSteer: false },
      { completionId: "unfinished-answer", secondSteer: true },
    ].map(({ completionId, secondSteer }) => ({
      name: `unfinished answer (${completionId}, second steer: ${secondSteer})`,
      barrierType: "none",
      isInboundUserMessage: true,
      provenance: undefined,
      unfinishedAnswer: true,
      completionId,
      secondSteer,
    })),
    {
      name: "inter-session steering with provenance",
      barrierType: "none",
      isInboundUserMessage: false,
      unfinishedAnswer: false,
      completionId: "unfinished-answer",
      secondSteer: false,
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:sender:main",
        sourceTool: "sessions_send",
      },
    },
  ])(
    "persists already visible output before $name",
    async ({
      barrierType,
      isInboundUserMessage,
      provenance,
      unfinishedAnswer,
      completionId,
      secondSteer,
    }) => {
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
        agentId: "main",
        sessionKey: params.sessionKey!,
        storePath,
        entry: {
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          updatedAt: Date.now(),
        },
      });
      const createUserTurnRecorder = (text: string, idempotencyKey: string) => {
        let steerPersisted = false;
        return {
          message: { role: "user" as const, content: text, timestamp: 1 },
          async resolveMessage() {
            return this.message;
          },
          getAdmissionReceipt: () => undefined,
          markRuntimePersistencePending: vi.fn(),
          markRuntimePersisted: vi.fn(),
          markBlocked: vi.fn(),
          isBlocked: () => false,
          hasRuntimePersistencePending: () => false,
          waitForRuntimePersistence: async () => {},
          persistBlocked: async () => undefined,
          persistFallback: async () => undefined,
          persistApproved: vi.fn(async () => {
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
                ...(provenance ? { provenance } : {}),
              },
            });
            return undefined;
          }),
          hasPersisted: () => steerPersisted,
        } satisfies NonNullable<CodexSteeringQueueOptions["userTurnTranscriptRecorder"]>;
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
      await notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "pre-steer-commentary",
            phase: "commentary",
            text: "PRE-STEER-COMMENTARY",
          },
        },
      });
      for (const id of ["answer-a", "answer-b"]) {
        await notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id, phase: "final_answer", text: "" },
          },
        });
        await notify({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: id, delta: id },
        });
        await notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id, phase: "final_answer", text: id },
          },
        });
      }
      if (barrierType !== "none") {
        const barrier: JsonObject =
          barrierType === "commandExecution"
            ? {
                type: barrierType,
                id: "barrier",
                command: "true",
                cwd: params.workspaceDir,
                status: "inProgress",
                commandActions: [],
              }
            : barrierType === "dynamicToolCall"
              ? { type: barrierType, id: "barrier", tool: "memory_search", status: "inProgress" }
              : { type: barrierType, id: "barrier", durationMs: 250 };
        await notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: barrier,
          },
        });
      }
      if (unfinishedAnswer) {
        await notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "unfinished-answer",
              phase: "final_answer",
              text: "",
            },
          },
        });
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
      }

      expect(
        activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
          (call) => call[0] === params.sessionId,
        )?.[1],
      ).toMatchObject({ taskSuggestionDeliveryMode: "gateway" });

      // This public queue returns immediate eligibility; the handle's delivery
      // promise stays pending until the matching item/completed notification below.
      expect(
        queueActiveRunMessageForTest(params.sessionId, "steer this active turn", {
          debounceMs: 0,
          isInboundUserMessage,
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
      const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
        ?.clientUserMessageId;
      if (!clientUserMessageId) {
        throw new Error("turn/steer clientUserMessageId missing");
      }
      expect(await queueAccepted.promise).toBe(true);
      expect(onQueueAccepted).toHaveBeenCalledWith(true);

      await notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
        },
      });
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
              : message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("");
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
      if (unfinishedAnswer) {
        await notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: completionId,
              phase: "final_answer",
              text: "PRE-STEER-INCOMPLETE POST-STEER-CONTINUATION",
            },
          },
        });
      }
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
        const secondRequest = requests.findLast((entry) => entry.method === "turn/steer")
          ?.params as {
          clientUserMessageId: string;
        };
        await notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "second-steered-user-message",
              type: "userMessage",
              clientId: secondRequest.clientUserMessageId,
            },
          },
        });
      }
      await notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "final-answer",
            phase: "final_answer",
            text: "Steering completed.",
          },
        },
      });
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
      if (unfinishedAnswer) {
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
        return;
      }
      expect(prefix).toEqual([
        { role: "user", text: params.prompt, mirrorIdentity: "turn-1:prompt" },
        {
          role: "assistant",
          text: "PRE-STEER-COMMENTARY",
          mirrorIdentity: "turn-1:commentary:pre-steer-commentary",
        },
        { role: "assistant", text: "answer-a", mirrorIdentity: "turn-1:assistant:answer-a" },
        { role: "assistant", text: "answer-b", mirrorIdentity: "turn-1:assistant:answer-b" },
        {
          role: "user",
          text: "steer this active turn",
          mirrorIdentity: undefined,
          ...(provenance ? { provenance } : {}),
        },
      ]);
      expect(await readTextRows()).toEqual([
        ...prefix,
        { role: "assistant", text: "Steering completed.", mirrorIdentity: "turn-1:assistant" },
      ]);
    },
  );

  it("still steers an image when gateway question cancellation fails", async () => {
    const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
    const params = createSteeringParams();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");
    let handle:
      | {
          queueMessage: (
            text: string,
            options?: Parameters<typeof queueActiveRunMessageForTest>[2],
          ) => Promise<void>;
        }
      | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);

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
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
      },
    });
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

    await notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "automatic-compaction", type: "contextCompaction" },
      },
    });
    expect(
      queueActiveRunMessageForTest(params.sessionId, "session-file registered", { debounceMs: 0 }),
    ).toBe(true);
    await waitForMethod("turn/steer");
    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "session-file registered", text_elements: [] }],
          clientUserMessageId: "openclaw:turn-1:steer:1",
        },
      },
    ]);
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "automatic-compaction", type: "contextCompaction" },
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "steered-user-message",
          type: "userMessage",
          clientId: "openclaw:turn-1:steer:1",
        },
      },
    });

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
  });
  it("accepts message-tool-only steering for active Codex app-server source replies", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();
    params.sourceReplyDeliveryMode = "message_tool_only";

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    await waitAndQueueActiveRunMessage(params.sessionId, "subagent complete", {
      debounceMs: 0,
      steeringMode: "all",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "subagent complete", text_elements: [] }],
              clientUserMessageId: "openclaw:turn-1:steer:1",
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("seals unsent steering without erasing an earlier consumed dispatch", async () => {
    const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness(
      undefined,
      {
        persistedThreads: [],
      },
    );
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    let handle:
      | {
          queueMessage: (
            text: string,
            options: { debounceMs: number; onQueueAccepted?: (accepted: boolean) => void },
          ) => Promise<void>;
        }
      | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);
    const onDispatchedAccepted = vi.fn();
    const onUnsentAccepted = vi.fn();
    const onLateAccepted = vi.fn();
    const dispatchedDelivery = handle!.queueMessage("on the wire", {
      debounceMs: 0,
      onQueueAccepted: onDispatchedAccepted,
    });
    await vi.waitFor(
      () => expect(requests.filter((entry) => entry.method === "turn/steer")).toHaveLength(1),
      fastWait,
    );
    const steer = requests.find((entry) => entry.method === "turn/steer");
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
    const unsentDelivery = handle!.queueMessage("still debounced", {
      debounceMs: 30_000,
      onQueueAccepted: onUnsentAccepted,
    });
    const unsentRejected = expect(unsentDelivery).rejects.toThrow("queue admission sealed");

    // Raw receipt seals admission immediately, while serialized projection still
    // honors the matching consumption notification already ahead of the terminal.
    const consumed = notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
      },
    });
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
});
