import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { buildDeliveryFormatPrompt } from "../../infra/outbound/delivery-format-prompt.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { recordSessionHumanDirectMessage } from "../../sessions/session-state-events.js";
import { resolveEffectiveAgentSkillFilter } from "../../skills/discovery/agent-filter.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  prepareCommandHarnessCompletionRecovery,
} from "../agent-command-restart-recovery.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { resolveAgentRunContext } from "./run-context.js";
import { loadExecDefaultsRuntime, loadSkillsRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

export function prepareCommandSessionRecoveryEntry(
  params: Omit<
    Parameters<typeof prepareCommandHarnessCompletionRecovery>[0],
    "hasDeliveryContext"
  > & {
    deliveryContext?: DeliveryContext;
    now: number;
    isSessionRollover: boolean;
  },
) {
  const { entry, sessionId, runId, opts, now, isSessionRollover } = params;
  const { harnessCompletion, guardedHarnessCompletion, sourceOptions, isCompletionCurrent } =
    prepareCommandHarnessCompletionRecovery({
      ...params,
      hasDeliveryContext: Boolean(params.deliveryContext),
    });
  return {
    guardedHarnessCompletion,
    isCompletionCurrent,
    nextEntry: {
      ...entry,
      sessionId,
      updatedAt: now,
      sessionStartedAt: isSessionRollover ? now : entry.sessionStartedAt,
      lastInteractionAt: isSessionRollover ? now : entry.lastInteractionAt,
      ...buildCurrentRunRestartRecoveryClaim({
        deliveryContext: params.deliveryContext,
        deliveryMediaUrls: opts.internalDeliveryMediaUrls,
        disableMessageTool: opts.disableMessageTool,
        entry,
        forceRestartSafeTools: opts.forceRestartSafeTools,
        runId,
        harnessCompletion,
        ...sourceOptions,
        suppressTextDelivery: opts.internalDeliverySuppressText,
      }),
    },
  };
}

export async function prepareCommandSessionDiffBaseline(
  params: Parameters<typeof ensureSessionDiffBaseline>[0] & {
    sessionStore?: Record<string, InternalSessionEntry>;
  },
): Promise<InternalSessionEntry> {
  try {
    const entry = await ensureSessionDiffBaseline(params);
    if (params.sessionStore) {
      params.sessionStore[params.sessionKey] = entry;
    }
    return entry;
  } catch (error) {
    if (isSessionWorkStartInvalidatedError(error)) {
      throw error;
    }
    log.warn(
      `session diff baseline capture failed; continuing without attribution filtering: ${coerceErrorMessage(error)}`,
    );
    return params.entry;
  }
}

export async function prepareEmbeddedSessionState(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionId: string;
  storePath: string;
  sessionAgentId: string;
  lifecycleGeneration: string;
  runId: string;
  executionWorkspaceDir: string;
  watchSkills: boolean;
  isNewSession: boolean;
  isSubagentLaneTurn: boolean;
  suppressVisibleSessionEffects: boolean;
  thinkOnce?: ThinkLevel;
  thinkOverride?: ThinkLevel;
  persistedThinking?: ThinkLevel;
  verboseOverride?: VerboseLevel;
  persistedVerbose?: VerboseLevel;
  verboseDefault?: VerboseLevel;
  sessionStateActor: Parameters<typeof recordSessionHumanDirectMessage>[0]["actor"];
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}) {
  const requestedThinkLevel = params.thinkOnce ?? params.thinkOverride ?? params.persistedThinking;
  const resolvedVerboseLevel =
    params.verboseOverride ?? params.persistedVerbose ?? params.verboseDefault;
  const coordination = isSubagentCoordinationInputProvenance(params.opts.inputProvenance);

  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
  if (params.sessionKey || params.suppressVisibleSessionEffects) {
    registerAgentRunContext(params.runId, {
      ...(params.sessionKey ? { sessionKey: params.sessionKey, sessionId: params.sessionId } : {}),
      agentId: params.sessionAgentId,
      lifecycleGeneration: params.lifecycleGeneration,
      verboseLevel: resolvedVerboseLevel,
      isControlUiVisible: !params.suppressVisibleSessionEffects && !coordination,
      ...(coordination ? { projectSessionMessages: false } : {}),
      // Node and local command ingress may not have a separate chat activity owner.
      projectSessionActive: !params.suppressVisibleSessionEffects && !coordination,
    });
  }

  let sessionEntry = params.sessionEntry;
  const skillFilter = resolveEffectiveAgentSkillFilter(params.cfg, params.sessionAgentId);
  const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
  const [
    { getRemoteSkillEligibility, resolveReusableWorkspaceSkillSnapshot },
    { resolveNodeExecEligibility },
  ] = await Promise.all([loadSkillsRuntime(), loadExecDefaultsRuntime()]);
  const nodeSkillsEligibility = resolveNodeExecEligibility({
    cfg: params.cfg,
    sessionEntry,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  const skillSnapshotState = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId),
    executionWorkspaceDir: params.executionWorkspaceDir,
    config: params.cfg,
    agentId: params.sessionAgentId,
    existingSnapshot: params.isNewSession ? undefined : currentSkillsSnapshot,
    librarySelections: sessionEntry?.skillLibrarySelections,
    skillFilter,
    assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration),
    resolveEligibility: () => ({
      nodeSkills: nodeSkillsEligibility,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkillsEligibility.canExec,
      }),
    }),
    // A one-shot caller has no later turn to consume invalidations; persistent
    // watchers would keep its process alive after the reply has completed.
    watch: params.watchSkills && params.opts.oneShotCliRun !== true,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
  });
  const needsSkillsSnapshot =
    params.isNewSession || !currentSkillsSnapshot || skillSnapshotState.shouldRefresh;
  const skillsSnapshot = skillSnapshotState.snapshot;

  if (
    skillsSnapshot &&
    params.sessionStore &&
    params.sessionKey &&
    needsSkillsSnapshot &&
    !params.suppressVisibleSessionEffects
  ) {
    const now = Date.now();
    const current = sessionEntry ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
    const next: SessionEntry = {
      ...current,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: current.sessionStartedAt ?? now,
      skillsSnapshot,
    };
    sessionEntry = await persistAgentSession({
      agentId: params.sessionAgentId,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      initialEntry: current,
      entry: next,
    });
  }

  // Persist non-model-dependent command state before provider/model resolution.
  // Thinking is written only after the selected runtime validates it.
  const shouldPersistInitialSessionTouch =
    params.opts.skipInitialSessionTouch !== true || Boolean(params.verboseOverride);
  if (
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects &&
    shouldPersistInitialSessionTouch
  ) {
    const now = Date.now();
    const entry = params.sessionStore[params.sessionKey] ??
      sessionEntry ?? { sessionId: params.sessionId, updatedAt: now, sessionStartedAt: now };
    const next: SessionEntry = {
      ...entry,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: entry.sessionStartedAt ?? now,
      lastInteractionAt: now,
      agentStatus: undefined,
    };
    applyVerboseOverride(next, params.verboseOverride);
    sessionEntry = await persistAgentSession({
      agentId: params.sessionAgentId,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      initialEntry: entry,
      entry: next,
    });
  }
  if (params.sessionKey && !params.isSubagentLaneTurn) {
    const assertSignalCurrent = () => {
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      params.opts.abortSignal?.throwIfAborted();
      params.opts.assertSourceCurrent?.();
      params.opts.operatorAuthority?.assertCurrent();
    };
    await recordSessionHumanDirectMessage(
      {
        sessionKey: params.sessionKey,
        entry: sessionEntry,
        agentId: params.sessionAgentId,
        actor: params.sessionStateActor,
        channel: params.opts.channel,
        runId: params.runId,
      },
      {
        assertCurrent: assertSignalCurrent,
      },
    );
    assertSignalCurrent();
  }

  const runContext = resolveAgentRunContext(params.opts);
  // Announce and inter-session turns get the delivering channel's contract, like replies.
  const deliveryFormat =
    (params.opts.deliver === true || params.opts.sourceReplyDeliveryMode === "message_tool_only") &&
    buildDeliveryFormatPrompt({
      cfg: params.cfg,
      // Delivery preflight records the actual outbound target as reply* options.
      channel: params.opts.replyChannel ?? runContext.messageChannel,
      accountId: params.opts.replyAccountId ?? runContext.accountId,
      agentId: params.sessionAgentId,
      allowBootstrap: true,
    });
  const extraSystemPrompt = [params.opts.extraSystemPrompt, deliveryFormat].filter(Boolean);
  return {
    sessionEntry,
    requestedThinkLevel,
    resolvedVerboseLevel,
    skillsSnapshot,
    runContext,
    opts: deliveryFormat
      ? { ...params.opts, extraSystemPrompt: extraSystemPrompt.join("\n\n") }
      : params.opts,
  };
}

export type EmbeddedSessionState = Omit<
  Awaited<ReturnType<typeof prepareEmbeddedSessionState>>,
  "opts"
>;
