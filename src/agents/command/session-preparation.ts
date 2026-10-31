import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { prepareGoalContinuationContext } from "../../auto-reply/reply/goal-continuation-return.js";
import {
  buildGroupIntro,
  buildSourceConversationContext,
  defaultGroupActivation,
  resolveGroupRequireMention,
} from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import { prepareReplyConversation } from "../../auto-reply/reply/prompt-session-context.js";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { buildDeliveryFormatPrompt } from "../../infra/outbound/delivery-format-prompt.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { recordSessionHumanDirectMessage } from "../../sessions/session-state-events.js";
import { resolveEffectiveAgentSkillFilter } from "../../skills/discovery/agent-filter.js";
import { resolveSessionSkillExecutionWorkspace } from "../../skills/loading/workspace-skill-roots.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { isSyntheticSourceReplyTurn } from "../reply-completion.js";
import { loadExecDefaultsRuntime, loadSkillsRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

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
  // Matches Gateway admission so re-registration cannot publish private intake.
  const privateConversationWork =
    params.opts.privateCompletion === true ||
    isSubagentCoordinationInputProvenance(params.opts.inputProvenance);

  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
  if (params.sessionKey || params.suppressVisibleSessionEffects) {
    registerAgentRunContext(params.runId, {
      ...(params.sessionKey ? { sessionKey: params.sessionKey, sessionId: params.sessionId } : {}),
      agentId: params.sessionAgentId,
      lifecycleGeneration: params.lifecycleGeneration,
      verboseLevel: resolvedVerboseLevel,
      isControlUiVisible: !params.suppressVisibleSessionEffects && !privateConversationWork,
      ...(privateConversationWork ? { projectSessionMessages: false } : {}),
      // Node and local command ingress may not have a separate chat activity owner.
      projectSessionActive: !params.suppressVisibleSessionEffects && !privateConversationWork,
    });
  }

  let sessionEntry = params.sessionEntry;
  const skillFilter = resolveEffectiveAgentSkillFilter(params.cfg, params.sessionAgentId);
  const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
  const [
    { getRemoteSkillEligibility, resolveReusableWorkspaceSkillSnapshot },
    { resolveNodeExecEligibilityAsync },
  ] = await Promise.all([loadSkillsRuntime(), loadExecDefaultsRuntime()]);
  const nodeSkillsEligibility = await resolveNodeExecEligibilityAsync({
    cfg: params.cfg,
    sessionEntry: sessionEntry ?? null,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  const skillSnapshotState = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId),
    ...resolveSessionSkillExecutionWorkspace(sessionEntry, params.executionWorkspaceDir),
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

  const { sessionStore, sessionKey } = params;
  const updateSkills = skillsSnapshot !== undefined && needsSkillsSnapshot;
  const touchSession =
    params.opts.skipInitialSessionTouch !== true || Boolean(params.verboseOverride);
  if (
    sessionStore &&
    sessionKey &&
    !params.suppressVisibleSessionEffects &&
    (updateSkills || touchSession)
  ) {
    const now = Date.now();
    const entry = (updateSkills ? sessionEntry : (sessionStore[sessionKey] ?? sessionEntry)) ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
    const patch: Partial<SessionEntry> = {
      sessionId: params.sessionId,
      updatedAt: now,
      ...(entry.sessionStartedAt === undefined ? { sessionStartedAt: now } : {}),
    };
    if (updateSkills) {
      patch.skillsSnapshot = skillsSnapshot;
    }
    // Persist non-model-dependent state first; thinking waits for runtime validation.
    if (touchSession) {
      patch.lastInteractionAt = now;
      patch.agentStatus = undefined;
      if (params.verboseOverride !== undefined) {
        patch.verboseLevel = params.verboseOverride;
      }
    }
    let published = false;
    const persisted = await applySessionEntryOperation(
      { agentId: params.sessionAgentId, sessionKey, storePath: params.storePath },
      { kind: "fields", expected: { sessionId: entry.sessionId }, patch },
      {
        onCommitted: (current) => {
          published = true;
          sessionStore[sessionKey] = current;
        },
      },
    );
    sessionEntry = persisted ?? undefined;
    if (!sessionEntry) {
      delete sessionStore[sessionKey];
    } else if (!published) {
      sessionStore[sessionKey] = sessionEntry;
    }
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

  const { cfg, opts, sessionAgentId } = params;
  const runContext: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};
  const normalizedChannel = resolveMessageChannel(
    runContext.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel,
  );
  if (normalizedChannel) {
    runContext.messageChannel = normalizedChannel;
  }
  const normalizedAccountId = normalizeOptionalAccountId(runContext.accountId ?? opts.accountId);
  if (normalizedAccountId) {
    runContext.accountId = normalizedAccountId;
  }
  for (const key of ["groupId", "groupChannel", "groupSpace"] as const) {
    const value = (runContext[key] ?? opts[key])?.toString().trim();
    if (value) {
      runContext[key] = value;
    }
  }
  if (runContext.currentThreadTs == null) {
    const threadId = stringifyRouteThreadId(opts.threadId);
    if (threadId) {
      runContext.currentThreadTs = threadId;
    }
  }
  // Outbound targets let channel adapters detect same-conversation auto-threading.
  if (!runContext.currentChannelId && opts.to) {
    const trimmedTo = opts.to.trim();
    if (trimmedTo) {
      runContext.currentChannelId = trimmedTo;
    }
  }
  const deliveryFormat =
    (opts.deliver === true || opts.sourceReplyDeliveryMode === "message_tool_only") &&
    buildDeliveryFormatPrompt({
      cfg,
      channel: opts.replyChannel ?? runContext.messageChannel,
      accountId: opts.replyAccountId ?? runContext.accountId,
      agentId: sessionAgentId,
      allowBootstrap: true,
    });
  let conversationPrompt: string | undefined;
  // Reuse conversation guidance without borrowing the originating sender's authority.
  if (
    sessionEntry &&
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    isSyntheticSourceReplyTurn(opts)
  ) {
    const conversation = prepareReplyConversation({
      sessionEntry,
      ctx: {
        InternalTurnSource: "event",
        Provider: runContext.messageChannel,
        Surface: runContext.messageChannel,
        ChatType: sessionEntry.delivery?.kind === "internal" ? sessionEntry.chatType : undefined,
        OriginatingChannel: runContext.messageChannel,
        OriginatingTo: runContext.currentChannelId,
        AccountId: runContext.accountId,
        MessageThreadId: runContext.currentThreadTs,
      },
    });
    const ctx = { ...conversation.fields, CommandAuthorized: false };
    const shared = ctx.ChatType === "group" || ctx.ChatType === "channel";
    const sourceContext = buildSourceConversationContext({
      sessionCtx: ctx,
      sourceReplyDeliveryMode: await resolveSessionStableReplyMode({
        cfg,
        ctx,
        sessionEntry,
        sessionAgentId,
        sessionKey,
      }),
    });
    if (sourceContext) {
      // Metadata describes the conversation; delivery preflight owns formatting.
      const metadata = buildInboundMetaSystemPrompt(ctx, cfg, { includeFormattingHints: false });
      conversationPrompt = [
        deliveryFormat ? `${metadata}\n${deliveryFormat}` : metadata,
        sourceContext,
        shared &&
          buildGroupIntro({
            activation: conversation.activation,
            defaultActivation: defaultGroupActivation(
              await resolveGroupRequireMention({ cfg, group: conversation.group }),
            ),
          }),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  // Returned-result intake instructions belong to this turn. Ordinary peer
  // requests and existing producer-marked policy spans retain their placement.
  const returnedResultPrompt =
    !opts.extraSystemPromptTurnContext &&
    opts.extraSystemPrompt &&
    (opts.replyExpectation === "optional" || opts.privateCompletion === true) &&
    opts.inputProvenance?.kind === "inter_session" &&
    (opts.inputProvenance.sourceTool === "sessions_send" ||
      opts.inputProvenance.sourceTool === "subagent_announce");
  let preparedOpts = opts;
  if (conversationPrompt || deliveryFormat || returnedResultPrompt) {
    const extraSystemPrompt = [
      conversationPrompt,
      opts.extraSystemPrompt,
      !conversationPrompt && deliveryFormat,
    ]
      .filter(Boolean)
      .join("\n\n");
    preparedOpts = {
      ...opts,
      extraSystemPrompt,
      ...(conversationPrompt ? { silentReplyPromptMode: "none" as const } : {}),
      extraSystemPromptTurnContext: {
        start:
          returnedResultPrompt || conversationPrompt || !opts.extraSystemPrompt
            ? 0
            : opts.extraSystemPrompt.length + 2,
        text: returnedResultPrompt ? extraSystemPrompt : conversationPrompt || deliveryFormat || "",
      },
    };
  }
  prepareGoalContinuationContext({ runId: params.runId, sessionKey, sessionEntry });
  return {
    sessionEntry,
    requestedThinkLevel,
    resolvedVerboseLevel,
    skillsSnapshot,
    runContext,
    opts: preparedOpts,
  };
}

export type EmbeddedSessionState = Omit<
  Awaited<ReturnType<typeof prepareEmbeddedSessionState>>,
  "opts"
>;
