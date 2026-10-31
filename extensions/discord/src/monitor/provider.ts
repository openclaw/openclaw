import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { formatThreadBindingDurationLabel } from "openclaw/plugin-sdk/conversation-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { asDateTimestampMs, resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  createRuntimeConfigReader,
  captureRuntimeConfigAsyncReader,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  logVerbose,
  danger,
  warn,
  createSubsystemLogger,
  createNonExitingRuntime,
  shouldLogVerbose,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
  summarizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import {
  resolveDiscordAccount,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "../accounts.js";
import { createDiscordActivityButton } from "../activities/interaction.js";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { getDiscordEndpointRuntime } from "../endpoint-runtime.js";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalClientEnabled,
} from "../exec-approvals.js";
import type {
  BaseMessageInteractiveComponent,
  DiscordCommand,
  Modal,
} from "../internal/discord.js";
import { GatewayCloseCodes } from "../internal/gateway.js";
import { parseApplicationIdFromToken, probeDiscordApplicationId } from "../probe.js";
import { normalizeDiscordToken } from "../token.js";
import { createDiscordVoiceCommand, DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { setDiscordTranscriptsVoiceManager } from "../voice/transcripts-source.js";
import {
  createAgentComponentControls,
  createDiscordComponentControls,
  createDiscordComponentModal,
} from "./agent-components.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import {
  createDiscordExecApprovalButtonContext,
  createExecApprovalButton,
} from "./exec-approvals.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { registerDiscordListener } from "./listeners.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";
import {
  createDiscordCommandArgFallbackButton,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  createDiscordNativeCommand,
} from "./native-command.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";
import { createDiscordQuestionButton } from "./questions.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import { formatDiscordStartupStatusMessage } from "./startup-status.js";
import { createDiscordReadyStatusPatch, type DiscordMonitorStatusSink } from "./status.js";

export type MonitorDiscordOpts = {
  scheduler: PluginServiceSchedulerV1;
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  readConfig?: () => OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
  commandDeployHashStore?: DiscordCommandDeployHashStore;
};

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8_000;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 2 * 60 * 1000;

type DiscordVoiceManager = import("../voice/voice-runtime.js").DiscordVoiceManager;

const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
}

function isDiscordDisallowedIntentsError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err);
  return message.includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts) {
  const { scheduler } = opts;
  const cfg = opts.config ?? (await captureRuntimeConfigAsyncReader()());
  const readConfig = opts.readConfig ?? createRuntimeConfigReader(cfg);
  const account = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token =
    normalizeDiscordToken(opts.token ?? undefined, "channels.discord.token") ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  let lifecycleGateway: MutableDiscordGateway | undefined;

  const rawDiscordCfg = account.config;
  const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
  const dmConfig = rawDiscordCfg.dm;
  const configuredDmAllowFrom = resolveDiscordAccountAllowFrom({
    cfg,
    accountId: account.accountId,
  });
  let guildEntries = rawDiscordCfg.guilds;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.discord !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: rawDiscordCfg.groupPolicy,
    defaultGroupPolicy,
  });
  const discordCfg =
    rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : { ...rawDiscordCfg, groupPolicy };
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "discord",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
    log: (message) => runtime.log?.(warn(message)),
  });
  let allowFrom = configuredDmAllowFrom ?? [];
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? DEFAULT_DISCORD_MEDIA_MAX_MB) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = resolvePromptHistoryLimit(
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
    20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy =
    resolveDiscordAccountDmPolicy({
      cfg,
      accountId: account.accountId,
    }) ?? "pairing";
  const discordProviderSessionRuntime = await import("./provider-session.runtime.js");
  const threadBindingIdleTimeoutMs =
    discordProviderSessionRuntime.resolveThreadBindingIdleTimeoutMs({
      channelIdleHoursRaw: discordCfg.threadBindings?.idleHours,
      sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
    });
  const threadBindingMaxAgeMs = discordProviderSessionRuntime.resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: discordCfg.threadBindings?.maxAgeHours,
    sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
  });
  const threadBindingsEnabled = discordProviderSessionRuntime.resolveThreadBindingsEnabled({
    channelEnabledRaw: discordCfg.threadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = slashCommand.ephemeral;
  const voiceEnabled = resolveDiscordVoiceEnabled(discordCfg.voice);
  if (voiceEnabled && getDiscordEndpointRuntime()) {
    throw new Error("Discord voice transport is unavailable while DISCORD_API_URL is configured");
  }

  const allowlistResolved = await resolveDiscordAllowlistConfig({
    accountId: account.accountId,
    token,
    guildEntries,
    allowFrom,
    discordConfig: discordCfg,
    fetcher: discordRestFetch,
    runtime,
  });
  guildEntries = allowlistResolved.guildEntries;
  allowFrom = allowlistResolved.allowFrom ?? [];
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    readConfig,
    accountId: account.accountId,
    discordConfig: discordCfg,
    token,
    runtime,
    discordRestFetch,
    abortSignal: opts.abortSignal,
    resolvedAllowlist: allowlistResolved,
  });

  if (shouldLogVerbose()) {
    const summarize = (entries: readonly string[] | undefined) =>
      summarizeStringEntries({ entries, limit: 4, emptyText: "any" });
    const allowFromSummary = summarize(allowFrom);
    const groupDmChannelSummary = summarize(groupDmChannels);
    const guildSummary = summarize(Object.keys(guildEntries ?? {}));
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${allowFromSummary} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${groupPolicy} guilds=${guildSummary} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=on threadBindings=${threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(threadBindingMaxAgeMs)}`,
    );
  }

  const configuredApplicationId = normalizeOptionalString(discordCfg.applicationId);
  const parsedApplicationId = configuredApplicationId ?? parseApplicationIdFromToken(token);
  const applicationIdProbe = parsedApplicationId
    ? ({ kind: "resolved", applicationId: parsedApplicationId } as const)
    : await probeDiscordApplicationId(token, 4000, discordRestFetch);
  if (applicationIdProbe.kind !== "resolved") {
    const at = Date.now();
    const terminal = applicationIdProbe.kind === "rejected";
    const probeError = formatErrorMessage(applicationIdProbe.error);
    const message = `Failed to resolve Discord application id: ${probeError}`;
    opts.setStatus?.({
      connected: false,
      lifecycle: terminal ? "blocked" : "recovering",
      terminalDisconnect: terminal ? true : undefined,
      lastEventAt: at,
      lastDisconnect: {
        at,
        ...(applicationIdProbe.status !== null ? { status: applicationIdProbe.status } : {}),
        error: probeError,
      },
      lastError: message,
    });
    throw new Error(message, { cause: applicationIdProbe.error });
  }
  const applicationId = applicationIdProbe.applicationId;

  const { commandSpecs } = await resolveDiscordProviderCommandSpecs({
    cfg,
    runtime,
    nativeEnabled,
    nativeSkillsEnabled,
    voiceEnabled,
  });
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? await discordProviderSessionRuntime.createThreadBindingManager({
        accountId: account.accountId,
        token,
        cfg,
        idleTimeoutMs: threadBindingIdleTimeoutMs,
        maxAgeMs: threadBindingMaxAgeMs,
      })
    : discordProviderSessionRuntime.createNoopThreadBindingManager(account.accountId);
  let lifecycleStarted = false;
  let gatewaySupervisor: ReturnType<typeof createDiscordGatewaySupervisor> | undefined;
  let deactivateMessageHandler: (() => Promise<void>) | undefined;
  let stopMonitorListeners: (() => Promise<void>) | undefined;
  let autoPresenceController:
    | Awaited<ReturnType<typeof createDiscordMonitorClient>>["autoPresenceController"]
    | null = null;
  try {
    if (opts.abortSignal?.aborted) {
      return;
    }
    if (threadBindingsEnabled) {
      const uncertainProbeKeys = new Set<string>();
      const reconciliation =
        await discordProviderSessionRuntime.reconcileAcpThreadBindingsOnStartup({
          cfg,
          accountId: account.accountId,
          sendFarewell: false,
          healthProbe: async ({ sessionKey, session }) => {
            const agentId = session.agentId;
            const storedState = session.acp?.state;
            const lastActivityAt = session.acp?.lastActivityAt;
            const probe = await (async (): Promise<{
              status: "healthy" | "stale" | "uncertain";
              reason?: string;
            }> => {
              const { getAcpSessionManager, isAcpRuntimeError } = discordProviderSessionRuntime;
              const manager = getAcpSessionManager();
              const statusProbeAbortController = new AbortController();
              const statusPromise = manager
                .getSessionStatus({
                  cfg,
                  sessionKey,
                  agentId,
                  signal: statusProbeAbortController.signal,
                })
                .then((status) => ({ kind: "status" as const, status }))
                .catch((error: unknown) => ({ kind: "error" as const, error }));
              const result = await raceWithTimeout(
                statusPromise,
                DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS,
                () => ({ kind: "timeout" as const }),
                { ref: false },
              );
              if (result.kind === "timeout") {
                statusProbeAbortController.abort();
              }
              let runningForMs = 0;
              if (storedState === "running") {
                const activityAtMs = asDateTimestampMs(lastActivityAt);
                const boundedActivityAtMs =
                  activityAtMs === undefined ? 0 : Math.max(0, Math.floor(activityAtMs));
                runningForMs = Math.max(0, Date.now() - boundedActivityAtMs);
              }
              const isStaleRunning =
                storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;
              if (result.kind === "timeout") {
                return isStaleRunning
                  ? { status: "stale", reason: "status-timeout-running-stale" }
                  : { status: "uncertain", reason: "status-timeout" };
              }
              if (result.kind === "error") {
                discordProviderSessionRuntime.rethrowIncognitoSessionError(result.error);
                const error = result.error;
                if (
                  isAcpRuntimeError(error) &&
                  ["SESSION_OWNER_MIGRATION_REQUIRED", "SESSION_OWNER_UNSUPPORTED"].includes(
                    error.detailCode ?? "",
                  )
                ) {
                  return { status: "uncertain", reason: formatErrorMessage(error) };
                }
                if (isAcpRuntimeError(error) && error.code === "ACP_SESSION_INIT_FAILED") {
                  return { status: "stale", reason: "session-init-failed" };
                }
                const message = formatErrorMessage(error);
                if (
                  message.includes("Session is not ACP-enabled") ||
                  message.includes("ACP session metadata missing")
                ) {
                  return { status: "stale", reason: "session-missing" };
                }
                return isStaleRunning
                  ? { status: "stale", reason: "status-error-running-stale" }
                  : { status: "uncertain", reason: "status-error" };
              }
              if (result.status.state === "error") {
                return { status: "uncertain", reason: "status-error-state" };
              }
              return { status: "healthy" };
            })();
            if (probe.status === "uncertain") {
              uncertainProbeKeys.add(`${sessionKey}${probe.reason ? ` (${probe.reason})` : ""}`);
            }
            return probe;
          },
        });
      if (reconciliation.removed > 0) {
        logVerbose(
          `discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}: ${reconciliation.staleSessionKeys.join(", ")}`,
        );
      }
      if (uncertainProbeKeys.size > 0) {
        logVerbose(
          `discord: ACP thread-binding health check uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`,
        );
      }
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    // SAFETY: Gateway startup supplies the full plugin channel runtime; the surface type is the minimal external view.
    const pluginChannelRuntime = opts.channelRuntime as PluginRuntime["channel"] | undefined;
    const accountContext = {
      readPolicy,
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
    };
    const commandContext: DiscordCommandArgContext = {
      ...accountContext,
      sessionPrefix,
      threadBindings,
      buildContext: pluginChannelRuntime?.inbound.buildContext,
      dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
    };
    const commands: DiscordCommand[] = commandSpecs.map((spec) => {
      if (nativeEnabled && voiceEnabled && spec.name === DISCORD_VOICE_COMMAND_SPEC.name) {
        return createDiscordVoiceCommand({
          ...accountContext,
          groupPolicy,
          getManager: () => voiceManagerRef.current,
          ephemeralDefault,
        });
      }
      return createDiscordNativeCommand({
        ...commandContext,
        command: spec,
        ephemeralDefault,
      });
    });

    const execApprovalsConfig = discordCfg.execApprovals ?? {};
    const execApprovalOptions = {
      cfg,
      accountId: account.accountId,
      configOverride: execApprovalsConfig,
    };
    const execApprovalsEnabled = isDiscordExecApprovalClientEnabled(execApprovalOptions);
    const approvalActionsEnabled = getDiscordExecApprovalApprovers(execApprovalOptions).length > 0;
    if (execApprovalsEnabled) {
      registerChannelRuntimeContext({
        channelRuntime: pluginChannelRuntime,
        channelId: "discord",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { token, config: execApprovalsConfig },
        abortSignal: opts.abortSignal,
      });
    }

    const componentContext = {
      ...accountContext,
      runtime,
      token,
      guildEntries,
      allowFrom,
      dmPolicy,
    };
    const components: BaseMessageInteractiveComponent[] = [
      createDiscordQuestionButton({
        cfg,
        accountId: account.accountId,
        authContext: componentContext,
      }),
      ...[
        createDiscordCommandArgFallbackButton,
        createDiscordModelPickerFallbackButton,
        createDiscordModelPickerFallbackSelect,
      ].map((create) => create(commandContext)),
    ];
    const activityButton = createDiscordActivityButton(
      { ...componentContext, channelRuntime: pluginChannelRuntime },
      applicationId,
    );
    if (activityButton) {
      components.push(activityButton);
    }
    const modals: Modal[] = [];
    if (approvalActionsEnabled) {
      components.push(
        createExecApprovalButton(
          createDiscordExecApprovalButtonContext({
            cfg,
            accountId: account.accountId,
            config: execApprovalsConfig,
          }),
        ),
      );
    }
    if (discordCfg.agentComponents?.enabled ?? true) {
      components.push(...createAgentComponentControls.map((create) => create(componentContext)));
      components.push(...createDiscordComponentControls.map((create) => create(componentContext)));
      modals.push(createDiscordComponentModal(componentContext));
    }
    const {
      client,
      gateway,
      gatewaySupervisor: createdGatewaySupervisor,
      autoPresenceController: createdAutoPresenceController,
    } = await createDiscordMonitorClient({
      scheduler,
      accountId: account.accountId,
      applicationId,
      token,
      restFetch: discordRestFetch,
      commands,
      components,
      modals,
      voiceEnabled,
      discordConfig: discordCfg,
      runtime,
      commandDeployHashStore: opts.commandDeployHashStore,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
    });
    lifecycleGateway = gateway;
    gatewaySupervisor = createdGatewaySupervisor;
    autoPresenceController = createdAutoPresenceController;

    runDiscordCommandDeployInBackground({
      client,
      runtime,
      enabled: nativeEnabled,
      accountId: account.accountId,
    });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<
      string,
      import("./message-handler.history.js").DiscordHistoryEntry[]
    >();
    const { botUserId, botUserName } = await fetchDiscordBotIdentity({
      client,
      token,
      runtime,
    });
    const monitorOptions = {
      readPolicy,
      client,
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      runtime,
      botUserId,
    };
    let voiceManager: DiscordVoiceManager | null = null;
    if (voiceEnabled) {
      const { DiscordVoiceManager } = await import("../voice/voice-runtime.js");
      const {
        DiscordVoiceGuildCreateListener,
        DiscordVoiceReadyListener,
        DiscordVoiceResumedListener,
        DiscordVoiceStateUpdateListener,
      } = await import("../voice/listeners.js");
      voiceManager = new DiscordVoiceManager({
        ...monitorOptions,
        scheduler,
      });
      setDiscordTranscriptsVoiceManager({
        accountId: account.accountId,
        manager: voiceManager,
      });
      voiceManagerRef.current = voiceManager;
      registerDiscordListener(client.listeners, new DiscordVoiceGuildCreateListener(voiceManager));
      registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
      registerDiscordListener(client.listeners, new DiscordVoiceResumedListener(voiceManager));
      registerDiscordListener(client.listeners, new DiscordVoiceStateUpdateListener(voiceManager));
    }
    const messageHandler = discordProviderSessionRuntime.createDiscordMessageHandler({
      ...monitorOptions,
      token,
      buildContext: pluginChannelRuntime?.inbound.buildContext,
      setStatus: opts.setStatus,
      abortSignal: opts.abortSignal,
      guildHistories,
      historyLimit,
      mediaMaxBytes,
      textLimit,
      replyToMode,
      dmEnabled,
      dmPolicy,
      groupDmEnabled,
      groupDmChannels,
      allowFrom,
      guildEntries,
      threadBindings,
      discordRestFetch,
    });
    deactivateMessageHandler = messageHandler.deactivate;
    const trackInboundEvent = opts.setStatus
      ? () => {
          const at = Date.now();
          // Gateway heartbeat ACKs are transport-level; Discord app events stay app-level only.
          opts.setStatus?.({ lastEventAt: at, lastInboundAt: at });
        }
      : undefined;
    stopMonitorListeners = registerDiscordMonitorListeners({
      ...monitorOptions,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels,
      dmPolicy,
      allowFrom,
      groupPolicy,
      guildEntries,
      logger,
      messageHandler,
      trackInboundEvent,
    });

    const botIdentity =
      botUserId && botUserName ? `${botUserId} (${botUserName})` : (botUserId ?? botUserName ?? "");
    runtime.log?.(
      formatDiscordStartupStatusMessage({
        gatewayReady: lifecycleGateway.isConnected,
        botIdentity: botIdentity || undefined,
      }),
    );
    if (lifecycleGateway?.isConnected) {
      opts.setStatus?.(createDiscordReadyStatusPatch());
    }

    lifecycleStarted = true;
    await runDiscordGatewayLifecycle({
      accountId: account.accountId,
      gateway: lifecycleGateway,
      runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.setStatus,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      threadBindings,
      gatewaySupervisor,
    });
  } finally {
    try {
      const listenersStopped = stopMonitorListeners?.();
      try {
        await deactivateMessageHandler?.();
      } finally {
        await listenersStopped;
      }
      await autoPresenceController?.stop();
      opts.setStatus?.({ connected: false });
      if (!lifecycleStarted) {
        try {
          lifecycleGateway?.disconnect();
        } catch (err) {
          runtime.error?.(
            danger(`discord: failed to disconnect gateway during startup cleanup: ${String(err)}`),
          );
        }
      }
      gatewaySupervisor?.dispose();
    } finally {
      if (!lifecycleStarted) {
        await threadBindings.stop();
      }
    }
  }
}
