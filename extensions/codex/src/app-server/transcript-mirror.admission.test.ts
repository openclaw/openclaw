import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { makeAgentUserMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectorFixture from "./event-projector.compact.test-support.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import {
  captureCodexSettledTurnFinalizationContext,
  CodexSettledTurnContext,
} from "./settled-turn-context.js";
import {
  codexTranscriptMirrorRuntime,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";

registerCodexEventProjectorTestLifecycle();

const publishTranscript = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>()),
  publishSessionTranscriptUpdateByIdentity: publishTranscript,
}));

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it.each([false, true])(
  "suppresses room-event text after a role-changing hook: %s",
  async (changeRole) => {
    const base = await createParams();
    const target = {
      agentId: "main",
      sessionId: base.sessionId,
      sessionKey: "agent:main:room-event",
      storePath: path.join(base.workspaceDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const draft = "SUPPRESSED_ROOM_EVENT_TEXT";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    if (changeRole) {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (input: unknown) => {
              const message = asOptionalRecord(asOptionalRecord(input)?.message);
              return JSON.stringify(message?.content).includes(draft)
                ? { message: makeAgentUserMessage({ content: draft }) }
                : undefined;
            },
          },
        ]),
      );
    }
    const params = {
      ...base,
      ...target,
      sessionTarget: target,
      suppressTranscriptOnlyAssistantPersistence: true,
      prepareAssistantTranscriptMessage,
    };
    const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
    const tool = { callId: "lookup-1", tool: "read" };
    projector.recordDynamicToolCall({ ...tool, arguments: { path: "notes.md" } });
    projector.recordDynamicToolResult({
      ...tool,
      success: true,
      terminalType: "completed",
      contentItems: [{ type: "inputText", text: "Completed lookup" }],
    });
    await projectorFixture.finish(projector, [projectorFixture.finalMessage("answer", draft)]);
    publishTranscript.mockClear();
    const result = await codexTranscriptMirrorRuntime.mirrorBestEffort({
      params,
      result: projectorFixture.result(projector),
      ...target,
      cwd: base.workspaceDir,
      threadId: "thread-1",
      turnId: "turn-1",
      notifyUserMessagePersisted: () => undefined,
    });
    const persisted = JSON.stringify(await readSessionTranscriptEvents(target));
    expect(persisted).not.toContain(draft);
    expect(JSON.stringify(publishTranscript.mock.calls)).not.toContain(draft);
    expect(JSON.stringify(publishTranscript.mock.calls)).toContain("Completed lookup");
    expect(persisted).toContain("Completed lookup");
    expect(persisted).toContain("lookup-1");
    expect(result.assistantTranscriptOwned).toBe(false);
    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledTimes(changeRole ? 0 : 1);
  },
);

it.each([
  ["monitor without source key", undefined, false, "available"],
  ["hidden subagent announcement", "announce:child:user", true, "available"],
  ["replayed settle wake", "announce:requester-settle:replay:user", true, "replayed"],
  ["removed admitted prompt", "removed:user", false, "removed"],
  ["closed consultation", "closed-consult:user", true, "closed"],
] as const)(
  "preserves host prompt ownership for an admitted %s",
  async (_label, idempotencyKey, hidden, recovery) => {
    const admittedContent = "Check the admitted monitor.";
    const upstreamUserText =
      recovery === "replayed" ? "Restarted: check the monitor." : "Check the monitor.";
    const turnId = recovery === "replayed" ? "turn-2" : "turn-1";
    const promptMetadata = {
      content: admittedContent,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      __openclaw: {
        mirrorIdentity: `${turnId}:prompt`,
        mirrorOrigin: "codex-app-server",
        upstreamUserText,
      },
    };
    const createUserTurnTranscriptRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const base = await createParams();
    const target = {
      agentId: "main",
      sessionId: base.sessionId,
      sessionKey: "agent:main:monitor",
      storePath: path.join(base.workspaceDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: upstreamUserText,
        provenance: hidden
          ? {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: recovery === "replayed" ? "subagent_settle" : "agent_harness_task",
              ...(recovery === "replayed" ? { sourceSessionKey: "agent:main:child" } : {}),
            }
          : { kind: "internal_system", sourceTool: "heartbeat" },
        ...(hidden ? { display: false } : {}),
        ...(recovery === "closed" ? { excludeFromContext: true } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      target: { ...target, sessionEntry: undefined },
      beforeMessageWrite: ({ message }) => ({ ...message, content: admittedContent }),
    });
    await recorder.persistApproved();
    const admitted = structuredClone(recorder.getPersistedMessage?.());
    const runtimeAcknowledgement = vi.spyOn(recorder, "markRuntimePersisted");
    const onUserMessagePersisted = vi.fn();
    const params = {
      ...base,
      ...target,
      sessionTarget: target,
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    };
    const host = await createAdmittedHostCapabilityTestFixture(params);
    params.hostCapabilities =
      recovery === "removed"
        ? { ...host.hostCapabilities, annotateCurrentUserTurn: undefined }
        : host.hostCapabilities;
    try {
      if (recovery === "removed") {
        const manager = SessionManager.open(target, base.workspaceDir);
        expect(manager.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
      }
      const mirror = {
        params,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        cwd: base.workspaceDir,
        threadId: "thread-1",
        turnId,
        notifyUserMessagePersisted: createCodexAppServerUserMessagePersistenceNotifier(params),
      };
      if (recovery === "replayed") {
        await mirrorPromptAtTurnStartBestEffort({
          ...mirror,
          turnId: "turn-1",
          upstreamUserText: "Check the monitor.",
        });
        expect(recorder.getPersistedMessage?.()).toMatchObject({
          __openclaw: { mirrorIdentity: "turn-1:prompt", upstreamUserText: "Check the monitor." },
        });
        mirror.notifyUserMessagePersisted =
          createCodexAppServerUserMessagePersistenceNotifier(params);
        onUserMessagePersisted.mockClear();
      }
      const beforeMirror =
        recovery === "closed" ? await readSessionTranscriptEvents(target) : undefined;
      const promptMirror = mirrorPromptAtTurnStartBestEffort({ ...mirror, upstreamUserText });
      if (recovery === "closed") {
        host.closeHost();
      }
      await promptMirror;
      if (recovery === "closed") {
        expect(onUserMessagePersisted).not.toHaveBeenCalled();
        expect(runtimeAcknowledgement).not.toHaveBeenCalled();
        expect(await readSessionTranscriptEvents(target)).toEqual(beforeMirror);
        return;
      }
      const projector = new CodexAppServerEventProjector(params, "thread-1", turnId, {
        upstreamUserText,
      });
      const tool = { callId: "result", tool: "heartbeat_respond" };
      projector.recordDynamicToolCall({ ...tool, arguments: {} });
      projector.recordDynamicToolResult({
        ...tool,
        success: true,
        terminalType: "completed",
        contentItems: [{ type: "inputText", text: "Monitor completed." }],
      });
      const result = projector.buildResult(buildEmptyToolTelemetry());
      const mirrored = await codexTranscriptMirrorRuntime.mirrorBestEffort({ ...mirror, result });
      await codexTranscriptMirrorRuntime.mirrorBestEffort({ ...mirror, result });
      const captured = await captureCodexSettledTurnFinalizationContext({
        ...target,
        sessionTarget: target,
        sessionFile: base.sessionFile,
        model: "gpt-5.6-luna",
        turnId,
        settledMessages: result.messagesSnapshot,
        mirroredMessages: mirrored.mirroredMessages,
      });
      if (recovery === "available" || recovery === "replayed") {
        expect(captured).toBeInstanceOf(CodexSettledTurnContext);
        expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(
          recorder.getPersistedMessage?.(),
        );
      } else {
        expect(captured).toBeUndefined();
        expect(recorder.getPersistedMessage?.()).toEqual(admitted);
      }
      const events = await readSessionTranscriptEvents(target);
      const prompts = events.filter(
        (event) => asOptionalRecord(asOptionalRecord(event)?.message)?.role === "user",
      );
      expect(prompts).toHaveLength(recovery === "removed" ? 0 : 1);
      if (recovery === "available" || recovery === "replayed") {
        expect(prompts[0]).toMatchObject({
          message: {
            ...promptMetadata,
            ...(hidden ? { display: false } : {}),
          },
        });
        expect(recorder.getPersistedMessage?.()).toMatchObject(promptMetadata);
      }
      if (idempotencyKey) {
        expect(recorder.getPersistedMessage?.()?.idempotencyKey).toBe(idempotencyKey);
      }
      if (recovery === "replayed") {
        expect(prompts[0]).toMatchObject({
          message: {
            provenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "subagent_settle",
              sourceSessionKey: "agent:main:child",
            },
          },
        });
      }
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  },
);
