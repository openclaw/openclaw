import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import type { CodexTurnStartParams } from "./protocol.js";
import {
  assistantMessage,
  createResumeHarness,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

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
            {
              role: "toolResult",
              toolCallId: "receipt-call",
              toolName: "create_receipt",
              content: [{ type: "text", text: "Created amber receipt AMBER-731." }],
              isError: false,
              timestamp: 5,
            },
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
});
