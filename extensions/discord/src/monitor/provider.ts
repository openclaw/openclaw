import { inspect } from "node:util";
import {
  Client,
  RateLimitError,
  ReadyListener,
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
  type Plugin,
} from "@buape/carbon";
import { GatewayCloseCodes, type GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
import { Routes } from "discord-api-types/v10";
import { getAcpSessionManager } from "../../../../src/acp/control-plane/manager.js";
import { isAcpRuntimeError } from "../../../../src/acp/runtime/errors.js";
import { resolveTextChunkLimit } from "../../../../src/auto-reply/chunk.js";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import { listNativeCommandSpecsForConfig } from "../../../../src/auto-reply/commands-registry.js";
import type { HistoryEntry } from "../../../../src/auto-reply/reply/history.js";
import { listSkillCommandsForAgents } from "../../../../src/auto-reply/skill-commands.js";
import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsEnabled,
} from "../../../../src/channels/thread-bindings-policy.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../../../../src/config/commands.js";
import type { OpenClawConfig, ReplyToMode } from "../../../../src/config/config.js";
import { loadConfig } from "../../../../src/config/config.js";
import { isDangerousNameMatchingEnabled } from "../../../../src/config/dangerous-name-matching.js";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../../../../src/config/runtime-group-policy.js";
import { createConnectedChannelStatusPatch } from "../../../../src/gateway/channel-status-patches.js";
import { danger, logVerbose, shouldLogVerbose, warn } from "../../../../src/globals.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { getPluginCommandSpecs } from "../../../../src/plugins/commands.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../../../src/runtime.js";
import { summarizeStringEntries } from "../../../../src/shared/string-sample.js";
import { resolveDiscordAccount } from "../accounts.js";
import { getDiscordGatewayEmitter } from "../monitor.gateway.js";
import { fetchDiscordApplicationId } from "../probe.js";
import { normalizeDiscordToken } from "../token.js";
import {
  buildDiscordVoiceCommandDeploymentDefinition,
  createDiscordVoiceCommand,
} from "../voice/command.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentChannelSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentModal,
  createDiscordComponentRoleSelect,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect,
} from "./agent-components.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import { createExecApprovalButton, DiscordExecApprovalHandler } from "./exec-approvals.js";
import { attachEarlyGatewayErrorGuard } from "./gateway-error-guard.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadUpdateListener,
  registerDiscordListener,
} from "./listeners.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import { reconcileDiscordNativeCommands } from "./native-command-state.js";
import {
  createDiscordCommandArgFallbackButton,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  createDiscordNativeCommand,
  type DiscordNativeCommandDeploymentDefinition,
} from "./native-command.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import {
  createNoopThreadBindingManager,
  createThreadBindingManager,
  reconcileAcpThreadBindingsOnStartup,
} from "./thread-bindings.js";
import { formatThreadBindingDurationLabel } from "./thread-bindings.messages.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
};

type DiscordVoiceManager = import("../voice/manager.js").DiscordVoiceManager;
type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

type DiscordVoiceRuntimeModule = typeof import("../voice/manager.runtime.js");

let discordVoiceRuntimePromise: Promise<DiscordVoiceRuntimeModule> | undefined;

async function loadDiscordVoiceRuntime(): Promise<DiscordVoiceRuntimeModule> {
  discordVoiceRuntimePromise ??= import("../voice/manager.runtime.js");
  return await discordVoiceRuntimePromise;
}

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
}

function appendPluginCommandSpecs(params: {
  commandSpecs: NativeCommandSpec[];
  runtime: RuntimeEnv;
}): NativeCommandSpec[] {
  const merged = [...params.commandSpecs];
  const existingNames = new Set(
    merged.map((spec) => spec.name.trim().toLowerCase()).filter(Boolean),
  );
  for (const pluginCommand of getPluginCommandSpecs("discord")) {
    const normalizedName = pluginCommand.name.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    if (existingNames.has(normalizedName)) {
      params.runtime.error?.(
        danger(
          `discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`,
        ),
      );
      continue;
    }
    existingNames.add(normalizedName);
    merged.push({
      name: pluginCommand.name,
      description: pluginCommand.description,
      acceptsArgs: pluginCommand.acceptsArgs,
    });
  }
  return merged;
}

const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8_000;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 2 * 60 * 1000;

function isLegacyMissingSessionError(message: string): boolean {
  return (
    message.includes("Session is not ACP-enabled") ||
    message.includes("ACP session metadata missing")
  );
}

function classifyAcpStatusProbeError(params: { error: unknown; isStaleRunning: boolean }): {
  status: "stale" | "uncertain";
  reason: string;
} {
  if (isAcpRuntimeError(params.error) && params.error.code === "ACP_SESSION_INIT_FAILED") {
    return { status: "stale", reason: "session-init-failed" };
  }

  const message = params.error instanceof Error ? params.error.message : String(params.error);
  if (isLegacyMissingSessionError(message)) {
    return { status: "stale", reason: "session-missing" };
  }

  return params.isStaleRunning
    ? { status: "stale", reason: "status-error-running-stale" }
    : { status: "uncertain", reason: "status-error" };
}

async function probeDiscordAcpBindingHealth(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storedState?: "idle" | "running" | "error";
  lastActivityAt?: number;
}): Promise<{ status: "healthy" | "stale" | "uncertain"; reason?: string }> {
  const manager = getAcpSessionManager();
  const statusProbeAbortController = new AbortController();
  const statusPromise = manager
    .getSessionStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      signal: statusProbeAbortController.signal,
    })
    .then((status) => ({ kind: "status" as const, status }))
    .catch((error: unknown) => ({ kind: "error" as const, error }));

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutTimer = setTimeout(
      () => resolve({ kind: "timeout" }),
      DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS,
    );
    timeoutTimer.unref?.();
  });
  const result = await Promise.race([statusPromise, timeoutPromise]);
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
  }
  if (result.kind === "timeout") {
    statusProbeAbortController.abort();
  }
  const runningForMs =
    params.storedState === "running" && Number.isFinite(params.lastActivityAt)
      ? Date.now() - Math.max(0, Math.floor(params.lastActivityAt ?? 0))
      : 0;
  const isStaleRunning =
    params.storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;

  if (result.kind === "timeout") {
    return isStaleRunning
      ? { status: "stale", reason: "status-timeout-running-stale" }
      : { status: "uncertain", reason: "status-timeout" };
  }
  if (result.kind === "error") {
    return classifyAcpStatusProbeError({
      error: result.error,
      isStaleRunning,
    });
  }
  if (result.status.state === "error") {
    // ACP error state is recoverable (next turn can clear it), so keep the
    // binding unless stronger stale signals exist.
    return { status: "uncertain", reason: "status-error-state" };
  }
  return { status: "healthy" };
}

type DiscordNativeCommandSyncOutcome = "applied" | "skipped" | "failed";

async function runDiscordNativeCommandSyncOperation(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId?: string;
  startupStartedAt?: number;
  action: "deploy" | "reconcile";
  operation: () => Promise<void>;
}): Promise<DiscordNativeCommandSyncOutcome> {
  if (!params.enabled) {
    return "skipped";
  }
  const startupStartedAt = params.startupStartedAt ?? Date.now();
  const accountId = params.accountId ?? "default";
  const maxAttempts = 3;
  const maxRetryDelayMs = 15_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const isDailyCreateLimit = (err: unknown) =>
    err instanceof RateLimitError &&
    err.discordCode === 30034 &&
    /daily application command creates/i.test(err.message);
  const restClient = params.client.rest as {
    put: (path: string, data?: unknown, query?: unknown) => Promise<unknown>;
    options?: { queueRequests?: boolean };
  };
  const originalPut = restClient.put.bind(restClient);
  const previousQueueRequests = restClient.options?.queueRequests;
  restClient.put = async (path: string, data?: unknown, query?: unknown) => {
    const startedAt = Date.now();
    const body =
      data && typeof data === "object" && "body" in data
        ? (data as { body?: unknown }).body
        : undefined;
    const commandCount = Array.isArray(body) ? body.length : undefined;
    const bodyBytes =
      body === undefined
        ? undefined
        : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    params.runtime.log?.(
      `discord startup [${accountId}] deploy-rest:put:start ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path}${typeof commandCount === "number" ? ` commands=${commandCount}` : ""}${typeof bodyBytes === "number" ? ` bytes=${bodyBytes}` : ""}`,
    );
    try {
      const result = await originalPut(path, data, query);
      params.runtime.log?.(
        `discord startup [${accountId}] deploy-rest:put:done ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (err) {
      params.runtime.error?.(
        `discord startup [${accountId}] deploy-rest:put:error ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt} error=${formatErrorMessage(err)}`,
      );
      throw err;
    }
  };
  try {
    if (restClient.options) {
      // Carbon's request queue retries 429s internally and can block startup for
      // minutes before surfacing the real error. Disable it for deploy so quota
      // errors like Discord 30034 fail fast and don't wedge the provider.
      restClient.options.queueRequests = false;
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await params.operation();
        return "applied";
      } catch (err) {
        if (isDailyCreateLimit(err)) {
          params.runtime.log?.(
            warn(
              `discord: native command ${params.action} skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota.`,
            ),
          );
          return "skipped";
        }
        if (!(err instanceof RateLimitError) || attempt >= maxAttempts) {
          throw err;
        }
        const retryAfterMs = Math.max(0, Math.ceil(err.retryAfter * 1000));
        if (retryAfterMs > maxRetryDelayMs) {
          params.runtime.log?.(
            warn(
              `discord: native command ${params.action} skipped for ${accountId}; retry_after=${retryAfterMs}ms exceeds startup budget. Existing slash commands stay active.`,
            ),
          );
          return "skipped";
        }
        if (shouldLogVerbose()) {
          params.runtime.log?.(
            `discord startup [${accountId}] ${params.action}-retry ${Math.max(0, Date.now() - startupStartedAt)}ms attempt=${attempt}/${maxAttempts - 1} retryAfterMs=${retryAfterMs} scope=${err.scope ?? "unknown"} code=${err.discordCode ?? "unknown"}`,
          );
        }
        await sleep(retryAfterMs);
      }
    }
  } catch (err) {
    const details = formatDiscordDeployErrorDetails(err);
    params.runtime.error?.(
      danger(
        `discord: failed to ${params.action} native commands: ${formatErrorMessage(err)}${details}`,
      ),
    );
    return "failed";
  } finally {
    if (restClient.options) {
      restClient.options.queueRequests = previousQueueRequests;
    }
    restClient.put = originalPut;
  }

  return "failed";
}

async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId?: string;
  startupStartedAt?: number;
}): Promise<DiscordNativeCommandSyncOutcome> {
  return await runDiscordNativeCommandSyncOperation({
    action: "deploy",
    client: params.client,
    runtime: params.runtime,
    enabled: params.enabled,
    accountId: params.accountId,
    startupStartedAt: params.startupStartedAt,
    operation: async () => {
      await params.client.handleDeployRequest();
    },
  });
}

function formatDiscordStartupGatewayState(gateway?: GatewayPlugin): string {
  if (!gateway) {
    return "gateway=missing";
  }
  const reconnectAttempts = (gateway as unknown as { reconnectAttempts?: unknown })
    .reconnectAttempts;
  return `gatewayConnected=${gateway.isConnected ? "true" : "false"} reconnectAttempts=${typeof reconnectAttempts === "number" ? reconnectAttempts : "na"}`;
}

function logDiscordStartupPhase(params: {
  runtime: RuntimeEnv;
  accountId: string;
  phase: string;
  startAt: number;
  gateway?: GatewayPlugin;
  details?: string;
}) {
  const elapsedMs = Math.max(0, Date.now() - params.startAt);
  const suffix = [params.details, formatDiscordStartupGatewayState(params.gateway)]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  params.runtime.log?.(
    `discord startup [${params.accountId}] ${params.phase} ${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`,
  );
}

function resolveDiscordNativeCommandReconcileOnStartup(params: {
  cfg: OpenClawConfig;
  discordConfig?: DiscordConfig;
}): boolean {
  return (
    params.discordConfig?.commands?.reconcileOnStartup ??
    params.cfg.channels?.discord?.commands?.reconcileOnStartup ??
    false
  );
}

function resolveDiscordNativeCommandReconcileFallbackReason(params: {
  client: Client;
  commands: BaseCommand[];
}): string | null {
  const clientOptions = params.client as unknown as {
    options?: { devGuilds?: string[] };
  };
  if (
    Array.isArray(clientOptions.options?.devGuilds) &&
    clientOptions.options.devGuilds.length > 0
  ) {
    return "devGuilds are configured";
  }
  for (const command of params.commands) {
    const guildIds = (command as { guildIds?: string[] }).guildIds;
    if (Array.isArray(guildIds) && guildIds.length > 0) {
      return `command "/${command.name}" is guild-scoped`;
    }
  }
  return null;
}

async function deployDiscordCommandsWithOptionalReconcile(params: {
  client: Client;
  commands: BaseCommand[];
  runtime: RuntimeEnv;
  enabled: boolean;
  reconcileOnStartup: boolean;
  cfg: OpenClawConfig;
  accountId: string;
  applicationId: string;
  commandSpecs: NativeCommandSpec[];
  extraDefinitions?: DiscordNativeCommandDeploymentDefinition[];
  startupStartedAt?: number;
}) {
  if (!params.enabled) {
    return;
  }
  if (!params.reconcileOnStartup) {
    params.runtime.log?.("discord: native commands using legacy deploy path");
    await deployDiscordCommands({
      client: params.client,
      runtime: params.runtime,
      enabled: params.enabled,
      accountId: params.accountId,
      startupStartedAt: params.startupStartedAt,
    });
    return;
  }
  const reconcileFallbackReason = resolveDiscordNativeCommandReconcileFallbackReason({
    client: params.client,
    commands: params.commands,
  });
  if (reconcileFallbackReason) {
    params.runtime.log?.(
      `discord: native command reconcile only supports global commands; falling back to legacy deploy path because ${reconcileFallbackReason}`,
    );
    await deployDiscordCommands({
      client: params.client,
      runtime: params.runtime,
      enabled: params.enabled,
      accountId: params.accountId,
      startupStartedAt: params.startupStartedAt,
    });
    return;
  }
  params.runtime.log?.("discord: native commands using reconcile-on-startup path");
  await runDiscordNativeCommandSyncOperation({
    action: "reconcile",
    client: params.client,
    runtime: params.runtime,
    enabled: params.enabled,
    accountId: params.accountId,
    startupStartedAt: params.startupStartedAt,
    operation: async () => {
      await reconcileDiscordNativeCommands({
        client: params.client,
        cfg: params.cfg,
        runtime: params.runtime,
        accountId: params.accountId,
        applicationId: params.applicationId,
        commandSpecs: params.commandSpecs,
        extraDefinitions: params.extraDefinitions,
      });
    },
  });
}
function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const status = (err as { status?: unknown }).status;
  const discordCode = (err as { discordCode?: unknown }).discordCode;
  const rawBody = (err as { rawBody?: unknown }).rawBody;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;

function isDiscordDisallowedIntentsError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err);
  return message.includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const startupStartedAt = Date.now();
  const cfg = opts.config ?? loadConfig();
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

  const rawDiscordCfg = account.config;
  const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
  const discordAccountThreadBindings =
    cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
  const dmConfig = rawDiscordCfg.dm;
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
  let allowFrom = discordCfg.allowFrom ?? dmConfig?.allowFrom;
  const mediaMaxBytes = (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = discordCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw:
      discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
    sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw:
      discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
    sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
  });
  const threadBindingsEnabled = resolveThreadBindingsEnabled({
    channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
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
  const reconcileNativeCommandsOnStartup = resolveDiscordNativeCommandReconcileOnStartup({
    cfg,
    discordConfig: discordCfg,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = slashCommand.ephemeral;
  const voiceEnabled = discordCfg.voice?.enabled !== false;

  const allowlistResolved = await resolveDiscordAllowlistConfig({
    token,
    guildEntries,
    allowFrom,
    fetcher: discordRestFetch,
    runtime,
  });
  guildEntries = allowlistResolved.guildEntries;
  allowFrom = allowlistResolved.allowFrom;

  if (shouldLogVerbose()) {
    const allowFromSummary = summarizeStringEntries({
      entries: allowFrom ?? [],
      limit: 4,
      emptyText: "any",
    });
    const groupDmChannelSummary = summarizeStringEntries({
      entries: groupDmChannels ?? [],
      limit: 4,
      emptyText: "any",
    });
    const guildSummary = summarizeStringEntries({
      entries: Object.keys(guildEntries ?? {}),
      limit: 4,
      emptyText: "any",
    });
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${allowFromSummary} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${groupPolicy} guilds=${guildSummary} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} nativeReconcile=${reconcileNativeCommandsOnStartup ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"} threadBindings=${threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(threadBindingMaxAgeMs)}`,
    );
  }

  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:start",
    startAt: startupStartedAt,
  });
  const applicationId = await fetchDiscordApplicationId(token, 4000, discordRestFetch);
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }
  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:done",
    startAt: startupStartedAt,
    details: `applicationId=${applicationId}`,
  });

  const maxDiscordCommands = 100;
  let skillCommands =
    nativeEnabled && nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
  let commandSpecs = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "discord" })
    : [];
  if (nativeEnabled) {
    commandSpecs = appendPluginCommandSpecs({ commandSpecs, runtime });
  }
  const initialCommandCount = commandSpecs.length;
  if (nativeEnabled && nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
    skillCommands = [];
    commandSpecs = listNativeCommandSpecsForConfig(cfg, { skillCommands: [], provider: "discord" });
    commandSpecs = appendPluginCommandSpecs({ commandSpecs, runtime });
    runtime.log?.(
      warn(
        `discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`,
      ),
    );
  }
  if (nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? createThreadBindingManager({
        accountId: account.accountId,
        token,
        cfg,
        idleTimeoutMs: threadBindingIdleTimeoutMs,
        maxAgeMs: threadBindingMaxAgeMs,
      })
    : createNoopThreadBindingManager(account.accountId);
  if (threadBindingsEnabled) {
    const uncertainProbeKeys = new Set<string>();
    const reconciliation = await reconcileAcpThreadBindingsOnStartup({
      cfg,
      accountId: account.accountId,
      sendFarewell: false,
      healthProbe: async ({ sessionKey, session }) => {
        const probe = await probeDiscordAcpBindingHealth({
          cfg,
          sessionKey,
          storedState: session.acp?.state,
          lastActivityAt: session.acp?.lastActivityAt,
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
        `discord: ACP thread-binding health probe uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`,
      );
    }
  }
  let lifecycleStarted = false;
  let releaseEarlyGatewayErrorGuard = () => {};
  let deactivateMessageHandler: (() => void) | undefined;
  let autoPresenceController: ReturnType<typeof createDiscordAutoPresenceController> | null = null;
  let earlyGatewayEmitter: ReturnType<typeof getDiscordGatewayEmitter> | undefined;
  let onEarlyGatewayDebug: ((msg: unknown) => void) | undefined;
  try {
    const commands: BaseCommand[] = commandSpecs.map((spec) =>
      createDiscordNativeCommand({
        command: spec,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        ephemeralDefault,
        threadBindings,
      }),
    );
    if (nativeEnabled && voiceEnabled) {
      commands.push(
        createDiscordVoiceCommand({
          cfg,
          discordConfig: discordCfg,
          accountId: account.accountId,
          groupPolicy,
          useAccessGroups,
          getManager: () => voiceManagerRef.current,
          ephemeralDefault,
        }),
      );
    }

    // Initialize exec approvals handler if enabled
    const execApprovalsConfig = discordCfg.execApprovals ?? {};
    const execApprovalsHandler = execApprovalsConfig.enabled
      ? new DiscordExecApprovalHandler({
          token,
          accountId: account.accountId,
          config: execApprovalsConfig,
          cfg,
          runtime,
        })
      : null;

    const agentComponentsConfig = discordCfg.agentComponents ?? {};
    const agentComponentsEnabled = agentComponentsConfig.enabled ?? true;

    const components: BaseMessageInteractiveComponent[] = [
      createDiscordCommandArgFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackSelect({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
    ];
    const modals: Modal[] = [];

    if (execApprovalsHandler) {
      components.push(createExecApprovalButton({ handler: execApprovalsHandler }));
    }

    if (agentComponentsEnabled) {
      const componentContext = {
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        guildEntries,
        allowFrom,
        dmPolicy,
        runtime,
        token,
      };
      components.push(createAgentComponentButton(componentContext));
      components.push(createAgentSelectMenu(componentContext));
      components.push(createDiscordComponentButton(componentContext));
      components.push(createDiscordComponentStringSelect(componentContext));
      components.push(createDiscordComponentUserSelect(componentContext));
      components.push(createDiscordComponentRoleSelect(componentContext));
      components.push(createDiscordComponentMentionableSelect(componentContext));
      components.push(createDiscordComponentChannelSelect(componentContext));
      modals.push(createDiscordComponentModal(componentContext));
    }

    class DiscordStatusReadyListener extends ReadyListener {
      async handle(_data: unknown, client: Client) {
        if (autoPresenceController?.enabled) {
          autoPresenceController.refresh();
          return;
        }

        const gateway = client.getPlugin<GatewayPlugin>("gateway");
        if (!gateway) {
          return;
        }

        const presence = resolveDiscordPresenceUpdate(discordCfg);
        if (!presence) {
          return;
        }

        gateway.updatePresence(presence);
      }
    }

    const clientPlugins: Plugin[] = [
      createDiscordGatewayPlugin({ discordConfig: discordCfg, runtime }),
    ];
    if (voiceEnabled) {
      clientPlugins.push(new VoicePlugin());
    }
    // Pass eventQueue config to Carbon so the gateway listener budget can be tuned.
    // Default listenerTimeout is 120s (Carbon defaults to 30s, which is too short for some
    // Discord normalization/enqueue work).
    const eventQueueOpts = {
      listenerTimeout: 120_000,
      ...discordCfg.eventQueue,
    };
    const client = new Client(
      {
        baseUrl: "http://localhost",
        deploySecret: "a",
        clientId: applicationId,
        publicKey: "a",
        token,
        autoDeploy: false,
        eventQueue: eventQueueOpts,
      },
      {
        commands,
        listeners: [new DiscordStatusReadyListener()],
        components,
        modals,
      },
      clientPlugins,
    );
    const earlyGatewayErrorGuard = attachEarlyGatewayErrorGuard(client);
    releaseEarlyGatewayErrorGuard = earlyGatewayErrorGuard.release;

    const lifecycleGateway = client.getPlugin<GatewayPlugin>("gateway");
    earlyGatewayEmitter = getDiscordGatewayEmitter(lifecycleGateway);
    onEarlyGatewayDebug = (msg: unknown) => {
      runtime.log?.(
        `discord startup [${account.accountId}] gateway-debug ${Math.max(0, Date.now() - startupStartedAt)}ms ${String(msg)}`,
      );
    };
    earlyGatewayEmitter?.on("debug", onEarlyGatewayDebug);
    if (lifecycleGateway) {
      autoPresenceController = createDiscordAutoPresenceController({
        accountId: account.accountId,
        discordConfig: discordCfg,
        gateway: lifecycleGateway,
        log: (message) => runtime.log?.(message),
      });
      autoPresenceController.start();
    }

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "deploy-commands:start",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
      details: `native=${nativeEnabled ? "on" : "off"} reconcile=${reconcileNativeCommandsOnStartup ? "on" : "off"} commandCount=${commands.length}`,
    });
    await deployDiscordCommandsWithOptionalReconcile({
      client,
      commands,
      runtime,
      enabled: nativeEnabled,
      reconcileOnStartup: reconcileNativeCommandsOnStartup,
      cfg,
      accountId: account.accountId,
      applicationId,
      commandSpecs,
      extraDefinitions: voiceEnabled ? [buildDiscordVoiceCommandDeploymentDefinition()] : [],
      startupStartedAt,
    });
    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "deploy-commands:done",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
    });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<string, HistoryEntry[]>();
    let botUserId: string | undefined;
    let botUserName: string | undefined;
    let voiceManager: DiscordVoiceManager | null = null;

    if (nativeDisabledExplicit) {
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "clear-native-commands:start",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
      });
      await clearDiscordNativeCommands({
        client,
        applicationId,
        runtime,
      });
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "clear-native-commands:done",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
      });
    }

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "fetch-bot-identity:start",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
    });
    try {
      const botUser = await client.fetchUser("@me");
      botUserId = botUser?.id;
      botUserName = botUser?.username?.trim() || botUser?.globalName?.trim() || undefined;
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "fetch-bot-identity:done",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
        details: `botUserId=${botUserId ?? "<missing>"} botUserName=${botUserName ?? "<missing>"}`,
      });
    } catch (err) {
      runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
      logDiscordStartupPhase({
        runtime,
        accountId: account.accountId,
        phase: "fetch-bot-identity:error",
        startAt: startupStartedAt,
        gateway: lifecycleGateway,
        details: String(err),
      });
    }

    if (voiceEnabled) {
      const { DiscordVoiceManager, DiscordVoiceReadyListener } = await loadDiscordVoiceRuntime();
      voiceManager = new DiscordVoiceManager({
        client,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        runtime,
        botUserId,
      });
      voiceManagerRef.current = voiceManager;
      registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
    }

    const messageHandler = createDiscordMessageHandler({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      token,
      runtime,
      setStatus: opts.setStatus,
      abortSignal: opts.abortSignal,
      workerRunTimeoutMs: discordCfg.inboundWorker?.runTimeoutMs,
      botUserId,
      guildHistories,
      historyLimit,
      mediaMaxBytes,
      textLimit,
      replyToMode,
      dmEnabled,
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
          opts.setStatus?.({ lastEventAt: at, lastInboundAt: at });
        }
      : undefined;

    registerDiscordListener(
      client.listeners,
      new DiscordMessageListener(messageHandler, logger, trackInboundEvent, {
        timeoutMs: eventQueueOpts.listenerTimeout,
      }),
    );
    const reactionListenerOptions = {
      cfg,
      accountId: account.accountId,
      runtime,
      botUserId,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels: groupDmChannels ?? [],
      dmPolicy,
      allowFrom: allowFrom ?? [],
      groupPolicy,
      allowNameMatching: isDangerousNameMatchingEnabled(discordCfg),
      guildEntries,
      logger,
      onEvent: trackInboundEvent,
    };
    registerDiscordListener(client.listeners, new DiscordReactionListener(reactionListenerOptions));
    registerDiscordListener(
      client.listeners,
      new DiscordReactionRemoveListener(reactionListenerOptions),
    );

    registerDiscordListener(
      client.listeners,
      new DiscordThreadUpdateListener(cfg, account.accountId, logger),
    );

    if (discordCfg.intents?.presence) {
      registerDiscordListener(
        client.listeners,
        new DiscordPresenceListener({ logger, accountId: account.accountId }),
      );
      runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
    }

    const botIdentity =
      botUserId && botUserName ? `${botUserId} (${botUserName})` : (botUserId ?? botUserName ?? "");
    runtime.log?.(`logged in to discord${botIdentity ? ` as ${botIdentity}` : ""}`);
    if (lifecycleGateway?.isConnected) {
      opts.setStatus?.(createConnectedChannelStatusPatch());
    }

    lifecycleStarted = true;
    earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
    onEarlyGatewayDebug = undefined;
    await runDiscordGatewayLifecycle({
      accountId: account.accountId,
      client,
      runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.setStatus,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      execApprovalsHandler,
      threadBindings,
      pendingGatewayErrors: earlyGatewayErrorGuard.pendingErrors,
      releaseEarlyGatewayErrorGuard,
    });
  } finally {
    deactivateMessageHandler?.();
    autoPresenceController?.stop();
    opts.setStatus?.({ connected: false });
    if (onEarlyGatewayDebug) {
      earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
    }
    releaseEarlyGatewayErrorGuard();
    if (!lifecycleStarted) {
      threadBindings.stop();
    }
  }
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(Routes.applicationCommands(params.applicationId), {
      body: [],
    });
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to clear native commands: ${String(err)}`));
  }
}

export const __testing = {
  createDiscordGatewayPlugin,
  resolveDiscordRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDiscordRestFetch,
  resolveThreadBindingsEnabled,
};
