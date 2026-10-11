import path from "node:path";
import type { CompactionReplayRejection } from "@openclaw/ai/transports";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  createAssistant,
  createTestSession,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";

export const checkpoint: CompactionReplayRejection = {
  data: "synthetic-rejected-checkpoint",
  id: "synthetic-checkpoint",
};
type ReplayOptions = NonNullable<Parameters<StreamFn>[2]> & {
  onCompactionRejected?: (rejected: CompactionReplayRejection) => void;
};

export async function createStreamCustodyFixture(
  makeRoot: () => string,
  provider: StreamFn,
  options: {
    withSessionWriteSettlement?: NonNullable<
      Parameters<typeof createTestSession>[0]
    >["withSessionWriteSettlement"];
    toolNames?: string[];
    thinkingRecovery?: boolean;
    onIdleTimeout?: (error: Error) => void;
    /** Durable owner carrying a real Anthropic compaction checkpoint for `model`. */
    anthropicCompaction?: { model: Model; owner: AssistantMessage };
  } = {},
) {
  const model =
    options.anthropicCompaction?.model ??
    (options.thinkingRecovery
      ? {
          ...testModel,
          api: "anthropic-messages",
          provider: "anthropic",
          id: "synthetic-anthropic",
        }
      : testModel);
  const root = makeRoot();
  const target = {
    agentId: "main",
    sessionId: "stream-custody",
    sessionKey: "agent:main:stream-custody",
    storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  const manager = SessionManager.open(target, root);
  manager.appendMessage({ role: "user", content: "Synthetic history", timestamp: 1 });
  manager.appendMessage(
    options.anthropicCompaction?.owner ?? {
      ...createAssistant(model, [
        ...(options.thinkingRecovery
          ? [
              {
                type: "thinking" as const,
                thinking: "Synthetic historical reasoning",
                thinkingSignature: "c3ludGhldGljLXNpZ25hdHVyZQ==",
              },
            ]
          : []),
        { type: "text", text: "Synthetic checkpoint owner" },
      ]),
      ...(!options.thinkingRecovery
        ? {
            providerReplay: {
              v: 1,
              type: "openai-responses-compaction",
              ...checkpoint,
              replayIndex: 0,
              provider: model.provider,
              api: model.api,
              model: model.id,
              baseUrlHash: "synthetic",
            },
          }
        : {}),
    },
  );
  const checkpointPresent = () =>
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.providerReplay?.data === checkpoint.data,
      );
  const thinkingPresent = () =>
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((block) => block.type === "thinking"),
      );
  const replayPresent = options.thinkingRecovery ? thinkingPresent : checkpointPresent;
  expect(replayPresent(), "fixture replay must survive durable append").toBe(true);
  const controller = new AbortController();
  const sdkSession = options.withSessionWriteSettlement
    ? (
        await createTestSession({
          sessionManager: manager,
          model,
          withSessionWriteSettlement: options.withSessionWriteSettlement,
        })
      ).session
    : undefined;
  const activeSession = sdkSession ?? {
    agent: { streamFn: provider },
    sessionId: target.sessionId,
    messages: manager.buildSessionContext().messages,
  };
  activeSession.agent.streamFn = provider;
  const repaired = vi.fn();
  const previousNotification = vi.fn();
  // Only preparation facts are supplied here; the installed stream, persistence,
  // cancellation, and work owners remain the production implementations.
  const input = {
    attempt: {
      config: {},
      model,
      modelId: model.id,
      provider: model.provider,
      runId: "stream-custody-run",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      timeoutMs: 120_000,
    },
    runAbortController: controller,
    prepared: {
      sessionRuntime: {
        agentSession: { activeSession },
        sessionManager: manager,
        contextGuards: { checkMidTurnPrecheck: () => {}, recordCacheTouch: () => {} },
        isOpenAIResponsesApi: !options.thinkingRecovery && !options.anthropicCompaction,
        state: { systemPromptText: "Synthetic system prompt" },
        transcriptPolicy: options.thinkingRecovery ? { preserveSignatures: true } : {},
        transport: {
          effectiveAgentTransport: "sse",
          compactionReplayEnabled: options.anthropicCompaction !== undefined,
        },
      },
      toolCatalog: {
        toolSearchRunPlan: {
          liveAllowedToolNames: new Set(options.toolNames),
          replayAllowedToolNames: new Set(options.toolNames),
        },
      },
    },
    setup: { sessionAgentId: "main" },
    diagnostics: { runTrace: createDiagnosticTraceContext() },
    lifecycle: { readYieldState: () => ({ yieldDetected: false }) },
  } as unknown as EmbeddedAttemptExecutionPhaseInput;
  const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
    runId: input.attempt.runId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  });
  const streamGuards = installEmbeddedAttemptStreamGuards(input, {
    onRejectedProviderReplayRepaired: repaired,
    onIdleTimeout: options.onIdleTimeout ?? (() => {}),
    diagnosticOwner,
  });
  expect(replayPresent(), "fixture preparation must retain replay").toBe(true);
  const streamOptions: ReplayOptions = {
    signal: controller.signal,
    onCompactionRejected: previousNotification,
  };
  return {
    input,
    diagnosticOwner,
    streamGuards,
    controller,
    manager,
    session: sdkSession,
    attempt: input.attempt,
    repaired,
    previousNotification,
    open: () =>
      activeSession.agent.streamFn(
        model,
        { messages: convertToLlm(activeSession.messages) },
        streamOptions,
      ),
    checkpointPresent,
    thinkingPresent,
    async holdWriter() {
      const entered = createDeferred();
      const release = createDeferred();
      const managerTarget = manager.getSessionTarget();
      if (!managerTarget) {
        throw new Error("Fixture manager lost its durable target");
      }
      expect(
        resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(target))),
      ).toBe(
        resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(managerTarget))),
      );
      const work = runOpenClawAgentWorkerWrite(
        toDatabaseOptions(resolveSqliteReadScope(target)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      return { release: release.resolve, work };
    },
  };
}
