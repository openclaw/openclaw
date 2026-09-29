import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  createAdmittedHostCapabilityTestFixture,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
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

it.each([
  {
    label: "monitor without source key",
    idempotencyKey: undefined,
    hidden: false,
    recovery: "available",
  },
  {
    label: "monitor with source key",
    idempotencyKey: "transport-user-key",
    hidden: false,
    recovery: "available",
  },
  {
    label: "hidden subagent announcement",
    idempotencyKey: "announce:child:user",
    hidden: true,
    recovery: "available",
  },
  {
    label: "excluded consultation",
    idempotencyKey: "consult:user",
    hidden: true,
    recovery: "excluded",
  },
  {
    label: "unavailable annotation capability",
    idempotencyKey: "unavailable:user",
    hidden: false,
    recovery: "unavailable",
  },
  {
    label: "removed admitted prompt",
    idempotencyKey: "removed:user",
    hidden: false,
    recovery: "removed",
  },
  {
    label: "closed consultation",
    idempotencyKey: "closed-consult:user",
    hidden: true,
    recovery: "closed",
  },
])(
  "preserves host prompt ownership for an admitted $label",
  async ({ idempotencyKey, hidden, recovery }) => {
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
        text: "Check the monitor.",
        provenance: hidden
          ? { kind: "inter_session", sourceChannel: "internal", sourceTool: "agent_harness_task" }
          : { kind: "internal_system", sourceTool: "heartbeat" },
        ...(hidden ? { display: false } : {}),
        ...(recovery === "excluded" || recovery === "closed" ? { excludeFromContext: true } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      target: { ...target, sessionEntry: undefined },
      beforeMessageWrite: ({ message }) => message,
    });
    await recorder.persistApproved();
    const admitted = structuredClone(recorder.getPersistedMessage?.());
    const runtimeAcknowledgement = vi.spyOn(recorder, "markRuntimePersisted");
    const onUserMessagePersisted = vi.fn();
    const attempt = {
      ...base,
      ...target,
      sessionTarget: target,
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    const params = {
      ...attempt,
      hostCapabilities:
        recovery === "unavailable" || recovery === "removed"
          ? { ...host.hostCapabilities, annotateCurrentUserTurn: undefined }
          : host.hostCapabilities,
    };
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
        turnId: "turn-1",
        notifyUserMessagePersisted: createCodexAppServerUserMessagePersistenceNotifier(params),
      };
      const beforeMirror =
        recovery === "closed" ? await readSessionTranscriptEvents(target) : undefined;
      const promptMirror = mirrorPromptAtTurnStartBestEffort({
        ...mirror,
        upstreamUserText: "Check the monitor.",
      });
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
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1", {
        upstreamUserText: "Check the monitor.",
      });
      projector.recordDynamicToolCall({
        callId: "result",
        tool: "heartbeat_respond",
        arguments: {},
      });
      projector.recordDynamicToolResult({
        callId: "result",
        tool: "heartbeat_respond",
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
        turnId: "turn-1",
        settledMessages: result.messagesSnapshot,
        mirroredMessages: mirrored.mirroredMessages,
      });
      if (recovery === "available") {
        expect(captured).toBeInstanceOf(CodexSettledTurnContext);
        expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(
          recorder.getPersistedMessage?.(),
        );
      } else {
        expect(captured).toBeUndefined();
        expect(recorder.getPersistedMessage?.()).toEqual(admitted);
      }
      const events = await readSessionTranscriptEvents(target);
      const prompts = events.filter((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message?.role === "user";
      });
      expect(prompts).toHaveLength(recovery === "removed" ? 0 : 1);
      if (recovery === "available") {
        expect(prompts[0]).toMatchObject({
          message: {
            content: "Check the monitor.",
            ...(hidden ? { display: false } : {}),
            __openclaw: { mirrorIdentity: "turn-1:prompt" },
          },
        });
      } else if (recovery !== "removed") {
        expect(asOptionalRecord(prompts[0])?.message).toEqual(admitted);
      }
      if (idempotencyKey) {
        expect(recorder.getPersistedMessage?.()?.idempotencyKey).toBe(idempotencyKey);
      }
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  },
);
