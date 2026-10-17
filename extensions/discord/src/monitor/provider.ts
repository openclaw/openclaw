import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { formatThreadBindingDurationLabel } from "openclaw/plugin-sdk/conversation-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  createRuntimeConfigReader,
  captureRuntimeConfigAsyncReader,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  logVerbose,
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
import {
  resolveDiscordAccount,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "../accounts.js";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { getDiscordEndpointRuntime } from "../endpoint-runtime.js";
import { GatewayCloseCodes } from "../internal/gateway.js";
import { parseApplicationIdFromToken, probeDiscordApplicationId } from "../probe.js";
import { normalizeDiscordToken } from "../token.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { setDiscordTranscriptsVoiceManager } from "../voice/transcripts-source.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { registerDiscordListener } from "./listeners.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { probeDiscordAcpBindingHealth } from "./provider.acp.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";
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
            const probe = await probeDiscordAcpBindingHealth({
              cfg,
              sessionKey,
              agentId: session.agentId,
              storedState: session.acp?.state,
              lastActivityAt: session.acp?.lastActivityAt,
              providerSessionRuntime: {
                getAcpSessionManager: discordProviderSessionRuntime.getAcpSessionManager,
                isAcpRuntimeError: discordProviderSessionRuntime.isAcpRuntimeError,
                rethrowIncognitoSessionError:
                  discordProviderSessionRuntime.rethrowIncognitoSessionError,
              },
            });
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
    const { commands, components, modals } = createDiscordProviderInteractionSurface({
      readPolicy,
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      applicationId,
      token,
      commandSpecs,
      nativeEnabled,
      voiceEnabled,
      groupPolicy,
      sessionPrefix,
      ephemeralDefault,
      threadBindings,
      voiceManagerRef,
      guildEntries,
      allowFrom,
      dmPolicy,
      runtime,
      channelRuntime: pluginChannelRuntime,
      abortSignal: opts.abortSignal,
    });
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
      const {
        DiscordVoiceGuildCreateListener,
        DiscordVoiceManager,
        DiscordVoiceReadyListener,
        DiscordVoiceResumedListener,
        DiscordVoiceStateUpdateListener,
      } = await import("../voice/voice-runtime.js");
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
    await cleanupDiscordProviderStartup({
      deactivateMessageHandler,
      stopMonitorListeners,
      autoPresenceController,
      setStatus: opts.setStatus,
      lifecycleStarted,
      lifecycleGateway,
      gatewaySupervisor,
      threadBindings,
      runtime,
    });
  }
}
