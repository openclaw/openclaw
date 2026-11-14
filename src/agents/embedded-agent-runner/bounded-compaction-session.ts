import { resolveOpenAIResponsesCompactEndpointPlan } from "@openclaw/ai/transports";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction-summary-budget.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { readRestoredSessionTranscriptInWorker } from "../../config/sessions/session-cold-storage-read.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { compactionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { createStandaloneCompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import type { PreparedCompaction } from "../sessions/prepared-compaction.types.js";
import { sessionManagerFromCompactionSource } from "../sessions/session-manager-view-types.js";
import { SessionManager } from "../sessions/session-manager.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import { resolveCompactionTimeoutMs } from "./compaction-safety-timeout.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import type { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import type { EmbeddedAgentCompactResult } from "./types.js";
import { mapThinkingLevelForProvider } from "./utils.js";

/** Native/provider compaction contracts still consume raw history. */
export function usesBoundedCompactionSource(runtime: PreparedCompactionRuntime): boolean {
  if (
    runtime.params.config?.agents?.defaults?.compaction?.provider ||
    runtime.effectiveModel.provider === "github-copilot"
  ) {
    return false;
  }
  if (
    runtime.trigger === "overflow" ||
    runtime.params.customInstructions?.trim() ||
    runtime.params.seedCompaction
  ) {
    return true;
  }
  const extraParams = runtime.runtimePlan.transport.resolveExtraParams({
    thinkingLevel: mapThinkingLevelForProvider(runtime.thinkLevel, runtime.effectiveModel),
    agentId: runtime.sessionAgentId,
    workspaceDir: runtime.effectiveWorkspace,
    model: runtime.effectiveModel,
  });
  return !resolveOpenAIResponsesCompactEndpointPlan(runtime.effectiveModel, extraParams).enabled;
}

export type BoundedCompactionSession = {
  manager: SessionManager;
  source: PreparedCompaction | undefined;
  settingsManager: SettingsManager;
};

/** Retain the transcript read owner; summary inputs reread its captured rows in short worker tasks. */
export async function withBoundedCompactionSession(
  runtime: PreparedCompactionRuntime,
  sessionTarget: SessionTranscriptRuntimeTarget,
  assertActive: () => void,
  settingsManager: SettingsManager,
  accounting: ReturnType<typeof readCompactionAccountingRecorder>,
  consume: (
    runtime: PreparedCompactionRuntime,
    prepared: BoundedCompactionSession,
  ) => Promise<EmbeddedAgentCompactResult>,
): Promise<EmbeddedAgentCompactResult> {
  const { params, effectiveCwd } = runtime;
  const settings = settingsManager.getCompactionSettings();
  // A raised standalone ceiling must constrain the worker's retained tail too,
  // before a full AgentSession exists to provide its final foreground budget.
  const requestBudget =
    accounting?.requestBudget ??
    ((settings.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) > MAX_COMPACTION_SUMMARY_CHARS
      ? createStandaloneCompactionRequestBudget({
          maxSummaryChars: settings.maxSummaryChars,
          contextWindow: runtime.contextTokenBudget,
          reserveTokens: settings.reserveTokens,
          systemPrompt: await runtime.buildSystemPromptText(),
          tools: runtime.effectiveTools,
        })
      : undefined);
  assertActive();
  let result: import("./types.js").EmbeddedAgentCompactResult | undefined;
  await withSessionTranscriptReadSource(
    sessionTarget,
    async (read) => {
      const skipped = await readRestoredSessionTranscriptInWorker(read, () =>
        read.owner.withCompactionSource(
          {
            target: sessionTarget,
            resolvedScope: read.resolved,
            expectedIdentity: read.expectedIdentity,
            settings,
            admission: resolveSessionTranscriptReadFence(sessionTarget),
            manual: runtime.trigger === "manual",
            requestBudget,
            requestFromEntryId: accounting?.requestFromEntryId,
            pendingUserEntryId: accounting?.pendingUserEntryId,
            requestState:
              accounting?.pendingRequestState ??
              (runtime.trigger === "overflow" ? "unresolved" : undefined),
            safeguard: {
              recentTurnsPreserve: Math.min(
                12,
                Math.max(
                  0,
                  Math.floor(params.config?.agents?.defaults?.compaction?.recentTurnsPreserve ?? 3),
                ),
              ),
              qualityGuardEnabled:
                params.config?.agents?.defaults?.compaction?.qualityGuard?.enabled ?? true,
            },
          },
          async (plan, source) => {
            assertActive();
            const manager = SessionManager[sessionManagerFromCompactionSource](
              sessionTarget,
              [plan.header, ...plan.retained],
              plan.version,
              effectiveCwd,
            );
            result = await consume(runtime, { manager, source, settingsManager });
          },
          params.abortSignal,
          resolveCompactionTimeoutMs(params.config) * 10,
        ),
      );
      if (skipped) {
        // A no-cut plan retains the whole window. Keep the existing skip hooks and accounting.
        const manager = await SessionManager.openAsync(
          sessionTarget,
          effectiveCwd,
          { compaction: true },
          params.abortSignal,
        );
        result = await consume(runtime, { manager, settingsManager, source: undefined });
      }
    },
    params.abortSignal,
    compactionLane,
  );
  if (!result) {
    throw new Error("Compaction source did not execute its prepared plan");
  }
  return result;
}
