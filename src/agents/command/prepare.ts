import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../../auto-reply/thinking.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { resolveAgentExplicitRecipientSession } from "../../infra/outbound/agent-delivery.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { labelRuntimeContextText } from "../../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE,
  resolveAgentHarnessSessionContextError,
} from "../../sessions/agent-harness-session-key.js";
import {
  assertAgentDatabaseAdmitted,
  evaluateAgentDatabaseAdmissions,
  hasAgentDatabaseAdmissions,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { resolveUserPath } from "../../utils.js";
import { isDeliverableMessageChannel, resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentRuntimeConfig } from "../agent-runtime-config.js";
import { resolveAgentRunCwd } from "../agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveAcpPromptBody, resolveInternalEventTranscriptBody } from "../internal-events.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { buildConfiguredModelCatalog, resolveConfiguredModelRef } from "../model-selection.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { isSyntheticSourceReplyTurn } from "../reply-completion.js";
import { normalizeSpawnedRunMetadata } from "../spawned-context.js";
import { resolveEffectiveAgentRuntime } from "../thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { ensureAgentWorkspace } from "../workspace.js";
import { acquireWorktreeRunLease, resolveWorktreeForPath } from "../worktrees/run-lease.js";
import { resolveExplicitAgentCommandSessionKey } from "./explicit-session-key.js";
import { loadAcpManagerRuntime } from "./runtime-loaders.js";
import { resolveSession } from "./session.js";
import type { AgentCommandOpts } from "./types.js";

export type PreparedAgentCommandRuntimeContext = Readonly<{
  config: OpenClawConfig;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}>;

export async function prepareAgentCommandExecution(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv,
  runtimeContext?: PreparedAgentCommandRuntimeContext,
) {
  const {
    abortSignal,
    assertSourceCurrent,
    operatorAuthority,
    lifecycleGeneration: preparationLifecycleGeneration,
  } = opts;
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  const rawExplicitSessionKey = opts.sessionKey?.trim();
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const rawTo = opts.to?.trim();
  const toSessionKey =
    !rawExplicitSessionKey && !requestedSessionId && classifySessionKeyShape(rawTo) === "agent"
      ? rawTo
      : undefined;
  const recipientChannel = resolveMessageChannel(opts.channel);
  const shouldResolveExplicitRecipientSession = Boolean(
    !rawExplicitSessionKey &&
    !requestedSessionId &&
    !toSessionKey &&
    opts.agentId?.trim() &&
    recipientChannel &&
    isDeliverableMessageChannel(recipientChannel) &&
    rawTo,
  );
  if (!opts.to && !requestedSessionId && !rawExplicitSessionKey && !opts.agentId) {
    throw new Error(
      "Pass --to <E.164>, --session-key, --session-id, or --agent to choose a session",
    );
  }

  const cfg = await (runtimeContext?.config ??
    resolveAgentRuntimeConfig(runtime, {
      runtimeTargetsChannelSecrets: opts.deliver === true,
      runtimeChannelSecretScope:
        opts.deliver !== true && shouldResolveExplicitRecipientSession && recipientChannel
          ? { channel: recipientChannel, accountId: opts.accountId }
          : undefined,
    }));
  const normalizedSpawned = normalizeSpawnedRunMetadata(opts);
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const shouldScopeDefaultAgentKey = Boolean(
    rawExplicitSessionKey &&
    !agentIdOverride &&
    classifySessionKeyShape(rawExplicitSessionKey) === "legacy_or_alias" &&
    !isUnscopedSessionKeySentinel(rawExplicitSessionKey),
  );
  const explicitSessionKey =
    toSessionKey ??
    resolveExplicitAgentCommandSessionKey({
      rawExplicitSessionKey,
      agentIdOverride,
      shouldScopeDefaultAgentKey,
      cfg,
    });
  if (explicitSessionKey && classifySessionKeyShape(explicitSessionKey) === "malformed_agent") {
    throw new Error(
      `Invalid --session-key "${explicitSessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`,
    );
  }
  if (
    agentIdOverride &&
    explicitSessionKey &&
    classifySessionKeyShape(explicitSessionKey) === "agent"
  ) {
    const sessionAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  if (agentIdOverride || explicitSessionKey) {
    if (!hasAgentDatabaseAdmissions()) {
      recordAgentDatabaseAdmissions(await evaluateAgentDatabaseAdmissions(cfg));
    }
    assertAgentDatabaseAdmitted(
      agentIdOverride ?? resolveSessionAgentId({ sessionKey: explicitSessionKey, config: cfg }),
    );
  }
  const agentCfg = cfg.agents?.defaults;

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const isSubagentLane = normalizeOptionalString(opts.lane) === AGENT_LANE_SUBAGENT;
  const hasExplicitTimeoutOption = opts.timeout !== undefined;
  const timeoutSecondsRaw = hasExplicitTimeoutOption
    ? (parseStrictNonNegativeInteger(opts.timeout) ?? Number.NaN)
    : isSubagentLane
      ? 0
      : undefined;
  if (Number.isNaN(timeoutSecondsRaw)) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: timeoutSecondsRaw });
  const runTimeoutOverrideMs = hasExplicitTimeoutOption ? timeoutMs : undefined;

  const selectedCommandOpts = toSessionKey
    ? { ...opts, to: undefined, sessionKey: explicitSessionKey }
    : opts;
  const explicitRecipientSession =
    shouldResolveExplicitRecipientSession && agentIdOverride && recipientChannel && rawTo
      ? await resolveAgentExplicitRecipientSession({
          cfg,
          agentId: agentIdOverride,
          channel: recipientChannel,
          to: rawTo,
          accountId: selectedCommandOpts.accountId,
          threadId: selectedCommandOpts.threadId,
        })
      : undefined;
  if (explicitRecipientSession?.error) {
    throw explicitRecipientSession.error;
  }
  let commandOpts: AgentCommandOpts = explicitRecipientSession?.sessionKey
    ? {
        ...selectedCommandOpts,
        channel: explicitRecipientSession.channel,
        to: explicitRecipientSession.to,
        accountId: explicitRecipientSession.accountId,
        threadId: explicitRecipientSession.threadId,
      }
    : selectedCommandOpts;
  const assertPreparationCurrent = () => {
    if (abortSignal?.aborted) {
      throw createAbortError("Operation aborted", { cause: abortSignal.reason });
    }
    assertSourceCurrent?.();
    operatorAuthority?.assertCurrent();
    if (preparationLifecycleGeneration !== undefined) {
      assertAgentRunLifecycleGenerationCurrent(preparationLifecycleGeneration);
    }
  };
  const sessionResolution = await resolveSession({
    cfg,
    to: commandOpts.to,
    sessionId: commandOpts.sessionId,
    sessionKey: explicitSessionKey ?? explicitRecipientSession?.sessionKey,
    agentId: agentIdOverride,
    signal: abortSignal,
    assertCurrent: assertPreparationCurrent,
  });
  assertPreparationCurrent();
  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionAgentId,
    storePath,
    isNewSession,
    previousSessionId,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const harnessSessionError = sessionKey
    ? resolveAgentHarnessSessionContextError(sessionKey, sessionEntryRaw)
    : undefined;
  if (harnessSessionError) {
    throw new Error(harnessSessionError);
  }
  if (isRawModelRun && sessionKey && sessionEntryRaw?.modelSelectionLocked === true) {
    throw new Error(AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE);
  }
  const sessionStore: Record<string, InternalSessionEntry> =
    sessionKey && sessionEntryRaw ? { [sessionKey]: sessionEntryRaw } : {};
  assertAgentDatabaseAdmitted(sessionAgentId);
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  const agentWorkspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const workspaceDirRaw = normalizedSpawned.workspaceDir ?? agentWorkspaceDir;
  const workspaceDir = resolveUserPath(workspaceDirRaw);
  const { getAcpSessionManager } = await loadAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const assertAcpPreparationCurrent = () => {
    assertPreparationCurrent();
    assertAgentDatabaseAdmitted(sessionAgentId);
  };
  const acpResolution = sessionKey
    ? await acpManager.resolveSessionAsync({
        cfg,
        sessionKey,
        agentId: sessionAgentId,
        assertCurrent: assertAcpPreparationCurrent,
      })
    : null;
  assertAcpPreparationCurrent();
  // Configured run cwd is a Gateway-local path; ACP-placed sessions ("ready" or
  // "stale") execute on their own node with a node-owned execCwd, so the config
  // fallback applies only to ordinary sessions and never bridges into a node.
  const isAcpPlacedSession = acpResolution !== null && acpResolution.kind !== "none";
  const cwd =
    normalizeOptionalString(opts.cwd) ??
    normalizeOptionalString(sessionEntryRaw?.spawnedCwd) ??
    (isAcpPlacedSession ? undefined : resolveAgentRunCwd(cfg, sessionAgentId));
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  const preparedMetadataSnapshot = runtimeContext?.pluginGeneration.pluginMetadataSnapshot;
  const manifestMetadataSnapshot = pluginsEnabled
    ? (preparedMetadataSnapshot ??
      resolvePluginMetadataSnapshot({ config: cfg, env: process.env, workspaceDir }))
    : undefined;
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot ?? [],
  } satisfies ModelManifestNormalizationContext;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    agentId: sessionAgentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: pluginsEnabled,
    ...modelManifestContext,
  });
  const configuredThinkingCatalog = buildConfiguredModelCatalog({
    cfg,
    workspaceDir,
    ...modelManifestContext,
  });
  const configuredThinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider: configuredModel.provider,
    modelId: configuredModel.model,
    agentId: sessionAgentId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
  });
  const sessionStableReplyMode = await resolveSessionStableReplyMode({
    cfg,
    ctx: { CommandAuthorized: false },
    sessionEntry: sessionEntryRaw,
    sessionAgentId,
    sessionKey,
  });
  commandOpts = {
    ...commandOpts,
    // Seed the same reusable policy before the first row and on later completion turns.
    cliSessionBindingFacts: commandOpts.cliSessionBindingFacts ?? {
      sourceReplyDeliveryMode: sessionStableReplyMode,
    },
    ...(sessionEntryRaw &&
    isSyntheticSourceReplyTurn({
      inputProvenance: commandOpts.inputProvenance,
    })
      ? {
          // Direct Gateway wakes have no inbound dispatcher to apply effective reply policy.
          sourceReplyDeliveryMode: commandOpts.sourceReplyDeliveryMode ?? sessionStableReplyMode,
        }
      : {}),
  };
  const thinkingLevelsHint = formatThinkingLevels(
    configuredModel.provider,
    configuredModel.model,
    ", ",
    configuredThinkingCatalog.length > 0 ? configuredThinkingCatalog : undefined,
    configuredThinkingRuntime,
  );
  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  const resolvedCwd = cwd ? resolveUserPath(cwd) : undefined;
  const worktreeSource = await resolveWorktreeForPath({
    sessionEntry: sessionEntryRaw,
    candidatePaths: [resolvedCwd ?? workspaceDir, workspaceDir],
  });
  const runLease = worktreeSource
    ? await acquireWorktreeRunLease(worktreeSource.record.id, { source: worktreeSource })
    : undefined;
  try {
    const { resolveAcpAgentWorkspaceProvisioningForTurn } =
      await import("../acp-workspace-provisioning.js");
    const workspaceProvisioning = await resolveAcpAgentWorkspaceProvisioningForTurn({
      cfg,
      agentId: sessionAgentId,
      workspaceDir: agentWorkspaceDir,
      cwd: resolvedCwd,
      sessionKey: sessionKey ?? undefined,
      sessionEntry: sessionEntryRaw ?? undefined,
    });
    await ensureAgentWorkspace({
      dir: agentWorkspaceDir,
      ensureBootstrapFiles: !agentCfg?.skipBootstrap,
      skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
      provisioning: workspaceProvisioning,
      guard: { assertHost: assertAcpPreparationCurrent },
    });
    const runId = opts.runId?.trim() || sessionId;
    let promptMessage = message;
    if (!isRawModelRun && (message.includes("$") || message.trimStart().startsWith("/"))) {
      const {
        expandExplicitSkillReferences,
        hasSkillReferenceCandidate,
        prepareSkillCommandsForWorkspace,
        resolveEffectiveAgentSkillFilter,
      } = await import("../../skills/discovery/chat-commands.runtime.js");
      const hasExplicitSkillCandidate =
        message.trimStart().startsWith("/") || hasSkillReferenceCandidate(message);
      if (hasExplicitSkillCandidate) {
        const skillFilter = resolveEffectiveAgentSkillFilter(cfg, sessionAgentId);
        const commandParams = {
          workspaceDir,
          cfg,
          agentId: sessionAgentId,
          sessionEntry: sessionEntryRaw,
          sessionKey,
          ...(preparedMetadataSnapshot ? { pluginMetadataSnapshot: preparedMetadataSnapshot } : {}),
          ...(skillFilter ? { skillFilter } : {}),
        };
        const lifecycleGeneration = opts.lifecycleGeneration;
        const assertCurrent =
          lifecycleGeneration !== undefined
            ? () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration)
            : undefined;
        const skillCommands = await prepareSkillCommandsForWorkspace(commandParams, assertCurrent);
        const allSkillCommands = skillFilter
          ? await prepareSkillCommandsForWorkspace(
              { ...commandParams, includeAllowlistHidden: true },
              assertCurrent,
            )
          : skillCommands;
        const expansion = expandExplicitSkillReferences({
          text: message,
          skillCommands,
          allSkillCommands,
        });
        if (expansion.error) {
          throw new Error(expansion.error);
        }
        promptMessage = expansion.body;
      }
    }
    const acpRuntimeContext = projectRuntimeContextFragments(opts.runtimeContextFragments ?? []);
    const body =
      !isRawModelRun && acpResolution?.kind === "ready"
        ? [
            acpRuntimeContext ? labelRuntimeContextText(acpRuntimeContext) : "",
            resolveAcpPromptBody(promptMessage, opts.internalEvents, opts.inputProvenance),
          ]
            .filter(Boolean)
            .join("\n\n")
        : promptMessage;
    const transcriptBody =
      opts.transcriptMessage ??
      resolveInternalEventTranscriptBody(message, opts.internalEvents, opts.inputProvenance);

    return {
      opts: commandOpts,
      body,
      transcriptBody,
      cfg,
      configuredThinkingCatalog,
      normalizedSpawned,
      agentCfg,
      thinkOverride,
      thinkOnce,
      verboseOverride,
      timeoutMs,
      runTimeoutOverrideMs,
      sessionId,
      sessionKey,
      sessionEntry: sessionEntryRaw,
      sessionStore,
      storePath,
      isNewSession,
      previousSessionId,
      persistedThinking,
      persistedVerbose,
      sessionAgentId,
      outboundSession,
      workspaceDir,
      cwd: resolvedCwd,
      agentDir,
      pluginsEnabled,
      manifestMetadataSnapshot,
      ...(runtimeContext ? { commandRuntimeContext: runtimeContext } : {}),
      modelManifestContext,
      runId,
      isSubagentLane,
      acpManager,
      acpResolution,
      runLease,
    };
  } catch (error) {
    await runLease?.release();
    throw error;
  }
}

export type PreparedAgentCommandExecution = Awaited<
  ReturnType<typeof prepareAgentCommandExecution>
>;
