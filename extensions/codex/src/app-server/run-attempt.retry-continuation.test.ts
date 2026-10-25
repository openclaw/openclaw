import path from "node:path";
import { embeddedAgentLog, type AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  createAdmittedHostCapabilityTestFixture,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../test-support/message-fixtures.test-support.js";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import type { CodexServerNotification, CodexTurnStartParams } from "./protocol.js";
import {
  assistantMessage,
  createResumeHarness,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import {
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";

setupRunAttemptTestHooks({ sessionOwner: null });

describe("Codex transient retry continuation", () => {
  it.each([
    { mode: "started", completedWork: false },
    { mode: "resumed", completedWork: false },
    { mode: "started", completedWork: true },
    { mode: "resumed", completedWork: true },
  ] as const)(
    "carries the current request past its admission fence ($mode, completed work: $completedWork)",
    async ({ mode, completedWork }) => {
      const params = createTestParams();
      params.agentId = "main";
      await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.sqlite"), "session-1");
      const target = {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        storePath: params.sessionTarget!.storePath!,
      };
      const manager = await SessionManager.openAsync(target, params.workspaceDir);
      await manager.appendMessageAsync(userMessage("Task A: summarize the old inventory.", 1));
      await manager.appendMessageAsync(assistantMessage("Task A is complete: cobalt widgets.", 2));
      const currentRequest = "Task B: create an amber inventory receipt and report its ID.";
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const recorder = createRecorder({
        input: { text: currentRequest, idempotencyKey: `${params.runId}:user` },
        target: { ...target, sessionEntry: undefined },
      });
      await recorder.persistApproved();
      params.userTurnTranscriptRecorder = recorder;
      params.suppressNextUserMessagePersistence = true;
      const settledMessages = completedWork
        ? ([
            {
              ...assistantMessage("", 4),
              content: [
                {
                  type: "toolCall",
                  id: "receipt-call",
                  name: "create_receipt",
                  arguments: { inventory: "amber" },
                },
              ],
              stopReason: "toolUse",
            },
            makeTextToolResult(
              "receipt-call",
              "create_receipt",
              "Created amber receipt AMBER-731.",
              false,
              5,
            ),
          ] satisfies AgentMessage[])
        : [];
      const currentManager = await SessionManager.openAsync(target, params.workspaceDir);
      for (const message of settledMessages) {
        await currentManager.appendMessageAsync(message);
      }
      const admission = recorder.getAdmissionReceipt();
      expect(admission).toBeDefined();
      const fencedHistory = await readMirroredSessionHistoryMessages({
        ...params,
        admission,
      });
      expect(JSON.stringify(fencedHistory)).toContain("Task A is complete");
      expect(JSON.stringify(fencedHistory)).not.toContain("Task B");
      expect(JSON.stringify(fencedHistory)).not.toContain("AMBER-731");

      params.prompt = "Continue from the existing transcript after the transient provider error.";
      params.continuation = { prompt: currentRequest, messages: settledMessages };
      if (mode === "resumed") {
        await writeCodexAppServerBinding(params.sessionFile, {
          threadId: "thread-existing",
          cwd: params.workspaceDir,
          model: params.modelId,
          modelProvider: "openai",
          historyCoveredThrough: new Date(30).toISOString(),
          dynamicToolsFingerprint: "[]",
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
        });
      }
      const harness = mode === "resumed" ? createResumeHarness() : createStartedThreadHarness();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await harness.completeTurn({
        threadId: mode === "resumed" ? "thread-existing" : "thread-1",
        turnId: "turn-1",
      });
      expect((await run).terminal).toEqual({ kind: "ok" });
      expect(harness.requests.map(({ method }) => method)).toContain(
        mode === "resumed" ? "thread/resume" : "thread/start",
      );
      const request = harness.requests.find(({ method }) => method === "turn/start")!
        .params as CodexTurnStartParams;
      const input = request.input
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      expect(input).toContain(currentRequest);
      if (completedWork) {
        expect(input).toContain("Created amber receipt AMBER-731.");
        expect(input).toContain("create_receipt");
      }
    },
  );

  it("captures settled evidence when the continuation runs on a new native turn", async () => {
    const params = createTestParams();
    params.agentId = "main";
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.sqlite"), "session-1");
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    };
    const currentRequest = "Create the amber inventory receipt.";
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      input: { text: currentRequest, idempotencyKey: `${params.runId}:user` },
      target: { ...target, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    params.userTurnTranscriptRecorder = recorder;
    const host = await createAdmittedHostCapabilityTestFixture(params);
    try {
      // The first native turn annotates the admitted prompt before the provider is overloaded.
      const firstAttempt = { ...params, hostCapabilities: host.hostCapabilities };
      await mirrorPromptAtTurnStartBestEffort({
        params: firstAttempt,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        cwd: params.workspaceDir,
        threadId: "thread-1",
        turnId: "turn-1",
        upstreamUserText: currentRequest,
        notifyUserMessagePersisted:
          createCodexAppServerUserMessagePersistenceNotifier(firstAttempt),
      });
      expect(recorder.getPersistedMessage?.()).toMatchObject({
        __openclaw: { mirrorIdentity: "turn-1:prompt" },
      });

      // The transient retry continues the same run with a suppressed internal prompt.
      const retry = {
        ...params,
        prompt: "Continue the current task from the existing transcript.",
        suppressNextUserMessagePersistence: true,
        onSettledTurn: async (attempt, captureContext) => {
          attempt.settledTurnFinalizationContext = await captureContext();
        },
      } satisfies typeof params;
      const second = createStartedThreadHarness(async (method) =>
        method === "turn/start" ? turnStartResult("turn-2") : undefined,
      );
      const warn = vi.spyOn(embeddedAgentLog, "warn");
      const retryRun = runCodexAppServerAttempt(retry);
      await retryRun.waitForTurnAccepted();
      const tool = {
        type: "commandExecution",
        id: "receipt-call",
        command: "echo AMBER-731",
        cwd: params.workspaceDir,
        status: "inProgress",
      };
      for (const notification of [
        { method: "item/started", item: tool },
        {
          method: "item/completed",
          item: { ...tool, status: "completed", aggregatedOutput: "AMBER-731\n", exitCode: 0 },
        },
      ]) {
        await second.notify({
          method: notification.method,
          params: { threadId: "thread-1", turnId: "turn-2", item: notification.item },
        } as CodexServerNotification);
      }
      await second.completeTurn({ threadId: "thread-1", turnId: "turn-2" });
      const result = await retryRun;

      expect(warn).not.toHaveBeenCalledWith(
        "codex settled-turn finalization context capture failed",
        expect.anything(),
      );
      expect(result.settledTurnFinalizationContext).toMatchObject({
        source: "harness",
        data: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: expect.stringContaining(currentRequest) }],
          },
          expect.objectContaining({ type: "function_call", call_id: "receipt-call" }),
          { type: "function_call_output", call_id: "receipt-call", output: "AMBER-731\n" },
        ],
      });
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });
});
