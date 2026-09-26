import path from "node:path";
import {
  createFailureMessage,
  appendInterruptedTurnMessage,
} from "../../../../packages/agent-core/src/turn-interruption.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { ImageContent } from "../../../llm/types.js";
import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createTestSession,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { agentSessionSetPromptPreparation } from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  persistToolResultProjections,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  prepareEmbeddedAttemptSessionBoundary,
  prepareEmbeddedAttemptSessionManager,
} from "./attempt-session-prepare.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function appendCompletedToolWork(
  manager: SessionManager,
  runId: string,
  beforeNested?: () => void,
  suffix = "",
) {
  const original = guardSessionManager(manager, { runId });
  original.appendMessage(
    createAssistant(
      testModel,
      [{ type: "toolCall", id: "completed-read" + suffix, name: "read", arguments: {} }],
      "toolUse",
    ),
  );
  beforeNested?.();
  original.appendMessage(
    createNestedToolActivity({
      runId,
      scopeId: "nested-scope" + suffix,
      afterEntryId: original.getAppendParentId(),
      startOrder: 0,
      parentToolCallId: "completed-read" + suffix,
      toolCallId: "nested-read" + suffix,
      toolName: "read",
      input: {},
      result: { content: [{ type: "text", text: "Nested read completed" }] },
      isError: false,
      startedAt: 2,
      timestamp: 3,
    }),
  );
  original.appendMessage({
    role: "toolResult",
    toolCallId: "completed-read" + suffix,
    toolName: "read",
    content: [{ type: "text", text: "Already read: use this completed result" }],
    isError: false,
    timestamp: 4,
  });
  original.appendCustomEntry("openclaw.cache-ttl", { timestamp: 4 });
}

export function appendOversizedCacheSnapshot(manager: SessionManager) {
  const state = createToolResultPromptProjectionState();
  state.frozen.add("prior-result");
  state.sourceHashByKey.set("prior-result", "synthetic-source");
  state.replacements.set("prior-result", {
    content: [{ type: "text", text: "x".repeat(64_000) }],
  });
  persistToolResultProjections(state, (type, data) => manager.appendCustomEntry(type, data));
}

export async function withInterruptedTurn(
  appendOnlyRuntimeContext: boolean,
  run: (fixture: {
    attempt: EmbeddedRunAttemptParams;
    prepare: (
      onCreated?: (manager: SessionManager) => void,
      extra?: Partial<Parameters<typeof prepareEmbeddedAttemptSessionManager>[0]>,
    ) => ReturnType<typeof prepareEmbeddedAttemptSessionManager>;
    target: NonNullable<ReturnType<SessionManager["getSessionTarget"]>>;
    revoke: () => void;
  }) => Promise<void>,
  options: {
    interruptedTurn?: boolean;
    toolProgress?: boolean;
    settledPrefix?: boolean;
    oversizedMetadata?: boolean;
  } = {},
) {
  await withOpenClawTestState({ label: "interrupted-keyed-replay" }, async (state) => {
    const runId = "interrupted-keyed-replay";
    const target = {
      agentId: "main",
      sessionId: runId,
      sessionKey: `agent:main:${runId}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      lifecycleRevision: "current-generation",
      activeWriterRunId: runId,
    });
    const makeRecorder = () =>
      createUserTurnTranscriptRecorder({
        target: { ...target, sessionEntry: undefined },
        input: { text: "Finish this exact turn", timestamp: 1, idempotencyKey: `${runId}:user` },
      });
    if (options.settledPrefix) {
      // A completed earlier turn that fenced current-turn reads must still see.
      const seed = SessionManager.open(target, state.workspaceDir);
      seed.appendMessage({
        role: "user",
        content: "Earlier settled question",
        timestamp: 1,
        idempotencyKey: `${runId}:earlier`,
      } as never);
      seed.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "Earlier settled answer" }]),
      );
    }
    const previous = makeRecorder();
    await previous.stageApproved!({ runId, assertCurrent: () => {} });
    const original = guardSessionManager(SessionManager.open(target, state.workspaceDir), {
      runId,
      preparedUserTurnMessage: await previous.resolveMessage(),
      preparedUserTurnTranscriptRecorder: previous,
    });
    previous.withPendingInput!(() =>
      original.appendMessage({ role: "user", content: "Finish this exact turn", timestamp: 1 }),
    );
    if (appendOnlyRuntimeContext) {
      const carrier = buildRuntimeContextCustomMessage("Original runtime context")!;
      original.appendCustomMessageEntry(
        carrier.customType,
        carrier.content,
        carrier.display,
        carrier.details,
      );
    }
    if (options.oversizedMetadata) {
      appendCompletedToolWork(original, runId, undefined, "-before-window");
      appendOversizedCacheSnapshot(original);
    }
    if (options.toolProgress) {
      appendCompletedToolWork(original, runId);
    }
    if (options.interruptedTurn !== false) {
      original.appendMessage(
        createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
      );
      await appendInterruptedTurnMessage([], (event) => {
        if (event.type !== "message_end") {
          return;
        }
        const interrupted = event.message;
        if (interrupted.role !== "custom") {
          throw new Error("expected interruption context");
        }
        original.appendCustomMessageEntry(
          interrupted.customType,
          interrupted.content,
          interrupted.display,
        );
      });
    }
    previous.finishPendingInput!("interrupted");
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const recorder = makeRecorder();
    await recorder.stageApproved!({ runId, assertCurrent: () => {} });
    const attempt = {
      config: {},
      contextTokenBudget: 8000,
      model: testModel,
      modelId: testModel.id,
      provider: testModel.provider,
      runId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      workspaceDir: state.workspaceDir,
      prompt: "Finish this exact turn",
      userTurnTranscriptRecorder: recorder,
    } as EmbeddedRunAttemptParams;
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle(attempt);
    let active = true;
    const withOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: {
            ...target,
            expectedLifecycleRevision: "current-generation",
            expectedWriterRunId: runId,
          },
          assertCommitAllowed: () => {
            if (!active) {
              throw new Error("original writer closed");
            }
          },
          withTranscriptWrite: (write) => lifecycle.withTranscriptWrite(write),
        },
        async () => await lifecycle.withTranscriptWrite(operation),
      );
    try {
      await run({
        attempt,
        target,
        revoke: () => {
          active = false;
        },
        prepare: (onCreated, extra) =>
          prepareEmbeddedAttemptSessionManager({
            ...extra,
            attempt,
            agentDir: state.agentDir("main"),
            effectiveCwd: state.workspaceDir,
            effectiveWorkspace: state.workspaceDir,
            onSessionManagerCreated: onCreated ?? (() => {}),
            replayAllowedToolNames: new Set(["read"]),
            resolveActiveContextEnginePluginId: () => undefined,
            sessionAgentId: "main",
            transcriptLifecycle: lifecycle,
            withOwnedTranscriptWrite,
          }),
      });
    } finally {
      recorder.finishPendingInput!("interrupted");
      await lifecycle.dispose();
      clearEmbeddedSessionPromptStates([target.sessionId]);
    }
  });
}

export async function withReplaySession(
  fixture: Parameters<Parameters<typeof withInterruptedTurn>[1]>[0],
  appendOnlyRuntimeContext: boolean,
  run: (session: AgentSession, submit: () => Promise<void>) => Promise<void>,
  options: {
    beforeStart?: () => Promise<unknown>;
    afterReplayPreparation?: () => Promise<unknown>;
    recovery?: "retry" | "compaction";
    images?: ImageContent[];
  } = {},
) {
  const { attempt, target, prepare } = fixture;
  const prepared = await prepare();
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
  if (options.beforeStart) {
    handlers.set("before_agent_start", [options.beforeStart]);
  }
  if (options.recovery === "compaction") {
    handlers.set("session_before_compact", [
      async (event) => {
        const { preparation } = event as {
          preparation: { firstKeptEntryId: string; tokensBefore: number };
        };
        return {
          compaction: {
            summary: "Continue the current request",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        };
      },
    ]);
  }
  const { session } = await createTestSession({
    sessionManager: prepared.sessionManager,
    resourceLoader: createResourceLoader(handlers),
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: options.recovery === "compaction",
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
      retry: { enabled: options.recovery === "retry", baseDelayMs: 1 },
    }),
  });
  session[agentSessionSetPromptPreparation](async () => {
    const admit = await prepared.prepareInitialUserTurnReplay?.();
    await options.afterReplayPreparation?.();
    return admit;
  });
  try {
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession: session,
      appendOnlyRuntimeContext,
      attempt,
      ...prepared.userMessageBoundary,
      isRawModelRun: false,
      sessionManager: prepared.sessionManager,
      setActiveSessionSystemPrompt: () => {},
    });
    const promptState = getEmbeddedSessionPromptState(target.sessionId);
    const submit = () =>
      submitEmbeddedAttemptPrompt({
        attempt,
        activeSession: session,
        appendOnlyRuntimeContext,
        contextTokenBudget: 8000,
        images: options.images ?? [],
        modelPrompt: attempt.prompt,
        onFinalPromptText: () => {},
        onSteeringAcknowledged: () => {},
        persistToolResultProjections: async () => {},
        runtimeOnly: false,
        sessionPromptState: promptState,
        systemPrompt: "",
        toolResultAggregateMaxChars: 8000,
        toolResultMaxChars: 4000,
        toolResultPromptProjectionState: promptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: prepared.sessionManager.getLeafId(),
        transcriptPrompt: attempt.prompt,
        runtimeContextMessage: buildRuntimeContextCustomMessage("Current runtime context"),
        promptActiveSession: (text, opts) =>
          attempt.userTurnTranscriptRecorder!.withPendingInput!(() =>
            session.prompt(text, { ...opts, expandPromptTemplates: false }),
          ),
      });
    await run(session, submit);
  } finally {
    session.dispose();
  }
}
