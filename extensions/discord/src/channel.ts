import { Separator, TextDisplay } from "@buape/carbon";
import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/channel-targets";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  createRuntimeOutboundDelegates,
  resolveOutboundSendDep,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } from "./audit.js";
import type { DiscordComponentMessageSpec } from "./components.js";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt,
} from "./exec-approvals.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./normalize.js";
import { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";
import type { DiscordProbe } from "./probe.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  buildTokenChannelStatusSummary,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  type OpenClawConfig,
} from "./runtime-api.js";
import { getDiscordRuntime } from "./runtime.js";
import { fetchChannelPermissionsDiscord } from "./send.js";
import { discordSetupAdapter } from "./setup-core.js";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";
import { collectDiscordStatusIssues } from "./status-issues.js";
import { parseDiscordTarget } from "./targets.js";
import { DiscordUiContainer } from "./ui.js";

type DiscordSendFn = ReturnType<
  typeof getDiscordRuntime
>["channel"]["discord"]["sendMessageDiscord"];

let discordProviderRuntimePromise:
  | Promise<typeof import("./monitor/provider.runtime.js")>
  | undefined;
let discordProbeRuntimePromise: Promise<typeof import("./probe.runtime.js")> | undefined;

async function loadDiscordProviderRuntime() {
  discordProviderRuntimePromise ??= import("./monitor/provider.runtime.js");
  return await discordProviderRuntimePromise;
}

async function loadDiscordProbeRuntime() {
  discordProbeRuntimePromise ??= import("./probe.runtime.js");
  return await discordProbeRuntimePromise;
}

const meta = getChatChannelMeta("discord");
const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;
const DISCORD_EXEC_APPROVAL_KEY = "execapproval";

const resolveDiscordDmPolicy = createScopedDmSecurityResolver<ResolvedDiscordAccount>({
  channelKey: "discord",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(discord|user):/i, "")
      .replace(/^<@!?(\d+)>$/, "$1"),
});

function formatDiscordIntents(intents?: {
  messageContent?: string;
  guildMembers?: string;
  presence?: string;
}) {
  if (!intents) {
    return "unknown";
  }
  return [
    `messageContent=${intents.messageContent ?? "unknown"}`,
    `guildMembers=${intents.guildMembers ?? "unknown"}`,
    `presence=${intents.presence ?? "unknown"}`,
  ].join(" ");
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function buildDiscordExecApprovalCustomId(
  approvalId: string,
  action: "allow-once" | "allow-always" | "deny",
): string {
  return [
    `${DISCORD_EXEC_APPROVAL_KEY}:id=${encodeCustomIdValue(approvalId)}`,
    `action=${action}`,
  ].join(";");
}

function formatDiscordApprovalPreview(value: string, maxChars: number): string {
  const trimmed = value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b")
    .trim();
  const raw = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
  return raw.replace(/`/g, "\u200b`");
}

function buildDiscordPluginPendingComponentSpec(params: {
  request: PluginApprovalRequest;
}): DiscordComponentMessageSpec {
  const request = params.request.request;
  const severity = request.severity ?? "warning";
  const severityLabel =
    severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning";
  const accentColor =
    severity === "critical" ? "#ED4245" : severity === "info" ? "#5865F2" : "#FAA61A";
  const expiresAtSeconds = Math.max(0, Math.floor(params.request.expiresAtMs / 1000));
  const metadataLines: string[] = [`- Severity: ${severityLabel}`];
  if (request.toolName) {
    metadataLines.push(`- Tool: ${request.toolName}`);
  }
  if (request.pluginId) {
    metadataLines.push(`- Plugin: ${request.pluginId}`);
  }
  if (request.agentId) {
    metadataLines.push(`- Agent: ${request.agentId}`);
  }
  return {
    container: { accentColor },
    blocks: [
      { type: "text", text: "## Plugin Approval Required" },
      { type: "text", text: "A plugin action needs your approval." },
      { type: "separator", divider: true, spacing: "small" },
      {
        type: "text",
        text: `### Title\n\`\`\`\n${formatDiscordApprovalPreview(request.title, 500)}\n\`\`\``,
      },
      {
        type: "text",
        text: `### Description\n${formatDiscordApprovalPreview(request.description, 1000)}`,
      },
      { type: "text", text: metadataLines.join("\n") },
      {
        type: "actions",
        buttons: [
          {
            label: "Allow once",
            style: "success",
            internalCustomId: buildDiscordExecApprovalCustomId(params.request.id, "allow-once"),
          },
          {
            label: "Always allow",
            style: "primary",
            internalCustomId: buildDiscordExecApprovalCustomId(params.request.id, "allow-always"),
          },
          {
            label: "Deny",
            style: "danger",
            internalCustomId: buildDiscordExecApprovalCustomId(params.request.id, "deny"),
          },
        ],
      },
      { type: "separator", divider: false, spacing: "small" },
      { type: "text", text: `-# Expires <t:${expiresAtSeconds}:R> · ID: ${params.request.id}` },
    ],
  };
}

function buildDiscordPluginResolvedComponentSpec(params: {
  resolved: PluginApprovalResolved;
}): DiscordComponentMessageSpec | undefined {
  const request = params.resolved.request;
  if (!request) {
    return undefined;
  }
  const decisionLabel =
    params.resolved.decision === "allow-once"
      ? "Allowed (once)"
      : params.resolved.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const accentColor =
    params.resolved.decision === "deny"
      ? "#ED4245"
      : params.resolved.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";
  const metadataLines: string[] = [];
  if (request.toolName) {
    metadataLines.push(`- Tool: ${request.toolName}`);
  }
  if (request.pluginId) {
    metadataLines.push(`- Plugin: ${request.pluginId}`);
  }
  if (request.agentId) {
    metadataLines.push(`- Agent: ${request.agentId}`);
  }
  return {
    container: { accentColor },
    blocks: [
      { type: "text", text: `## Plugin Approval: ${decisionLabel}` },
      {
        type: "text",
        text: params.resolved.resolvedBy ? `Resolved by ${params.resolved.resolvedBy}` : "Resolved",
      },
      { type: "separator", divider: true, spacing: "small" },
      {
        type: "text",
        text: `### Title\n\`\`\`\n${formatDiscordApprovalPreview(request.title, 500)}\n\`\`\``,
      },
      {
        type: "text",
        text: `### Description\n${formatDiscordApprovalPreview(request.description, 1000)}`,
      },
      ...(metadataLines.length > 0
        ? [{ type: "text" as const, text: metadataLines.join("\n") }]
        : []),
      { type: "separator", divider: false, spacing: "small" },
      { type: "text", text: `-# ID: ${params.resolved.id}` },
    ],
  };
}

const discordMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) =>
    getDiscordRuntime().channel.discord.messageActions?.describeMessageTool?.(ctx) ?? null,
  extractToolSend: (ctx) =>
    getDiscordRuntime().channel.discord.messageActions?.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    const ma = getDiscordRuntime().channel.discord.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Discord message actions not available");
    }
    return ma.handleAction(ctx);
  },
  requiresTrustedRequesterSender: ({ action, toolContext }) =>
    Boolean(toolContext && (action === "timeout" || action === "kick" || action === "ban")),
};

function buildDiscordCrossContextComponents(params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const trimmed = params.message.trim();
  const components: Array<TextDisplay | Separator> = [];
  if (trimmed) {
    components.push(new TextDisplay(params.message));
    components.push(new Separator({ divider: true, spacing: "small" }));
  }
  components.push(new TextDisplay(`*From ${params.originLabel}*`));
  return [new DiscordUiContainer({ cfg: params.cfg, accountId: params.accountId, components })];
}

function hasDiscordExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listDiscordAccountIds(cfg).some((accountId) => {
    const execApprovals = resolveDiscordAccount({ cfg, accountId }).config.execApprovals;
    if (!execApprovals?.enabled || (execApprovals.approvers?.length ?? 0) === 0) {
      return false;
    }
    const target = execApprovals.target ?? "dm";
    return target === "dm" || target === "both";
  });
}

const resolveDiscordAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedDiscordAccount) => account.config.guilds,
  outerLabel: (guildKey) => `guild ${guildKey}`,
  resolveOuterEntries: (guildCfg) => guildCfg?.users,
  resolveChildren: (guildCfg) => guildCfg?.channels,
  innerLabel: (guildKey, channelKey) => `guild ${guildKey} / channel ${channelKey}`,
  resolveInnerEntries: (channelCfg) => channelCfg?.users,
});

const resolveDiscordAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: resolveDiscordAccount,
  resolveToken: (account: ResolvedDiscordAccount) => account.token,
  resolveNames: ({ token, entries }) => resolveDiscordUserAllowlist({ token, entries }),
});

const collectDiscordSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedDiscordAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.discord !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Object.keys(account.config.guilds ?? {}).length > 0,
    configureRouteAllowlist: {
      surface: "Discord guilds",
      openScope: "any channel not explicitly denied",
      groupPolicyPath: "channels.discord.groupPolicy",
      routeAllowlistPath: "channels.discord.guilds.<id>.channels",
    },
    missingRouteAllowlist: {
      surface: "Discord guilds",
      openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels',
    },
  });

function normalizeDiscordAcpConversationId(conversationId: string) {
  const normalized = conversationId.trim();
  return normalized ? { conversationId: normalized } : null;
}

function matchDiscordAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  if (params.bindingConversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    params.bindingConversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function parseDiscordExplicitTarget(raw: string) {
  try {
    const target = parseDiscordTarget(raw, { defaultKind: "channel" });
    if (!target) {
      return null;
    }
    return {
      to: target.id,
      chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
    };
  } catch {
    return null;
  }
}

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount, DiscordProbe> =
  createChatChannelPlugin<ResolvedDiscordAccount, DiscordProbe>({
    base: {
      ...createDiscordPluginBase({
        setup: discordSetupAdapter,
      }),
      allowlist: {
        ...buildLegacyDmAccountAllowlistAdapter({
          channelId: "discord",
          resolveAccount: resolveDiscordAccount,
          normalize: ({ cfg, accountId, values }) =>
            discordConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
          resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
          resolveGroupPolicy: (account) => account.config.groupPolicy,
          resolveGroupOverrides: resolveDiscordAllowlistGroupOverrides,
        }),
        resolveNames: resolveDiscordAllowlistNames,
      },
      groups: {
        resolveRequireMention: resolveDiscordGroupRequireMention,
        resolveToolPolicy: resolveDiscordGroupToolPolicy,
      },
      mentions: {
        stripPatterns: () => ["<@!?\\d+>"],
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.",
          "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages.",
        ],
      },
      messaging: {
        normalizeTarget: normalizeDiscordMessagingTarget,
        resolveSessionTarget: ({ id }) => normalizeDiscordMessagingTarget(`channel:${id}`),
        parseExplicitTarget: ({ raw }) => parseDiscordExplicitTarget(raw),
        inferTargetChatType: ({ to }) => parseDiscordExplicitTarget(to)?.chatType,
        buildCrossContextComponents: buildDiscordCrossContextComponents,
        resolveOutboundSessionRoute: (params) => resolveDiscordOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeDiscordTargetId,
          hint: "<channelId|user:ID|channel:ID>",
        },
      },
      execApprovals: {
        getInitiatingSurfaceState: ({ cfg, accountId }) =>
          isDiscordExecApprovalClientEnabled({ cfg, accountId })
            ? { kind: "enabled" }
            : { kind: "disabled" },
        shouldSuppressLocalPrompt: ({ cfg, accountId, payload }) =>
          shouldSuppressLocalDiscordExecApprovalPrompt({
            cfg,
            accountId,
            payload,
          }),
        hasConfiguredDmRoute: ({ cfg }) => hasDiscordExecApprovalDmRoute(cfg),
        shouldSuppressForwardingFallback: ({ cfg, target }) =>
          (normalizeMessageChannel(target.channel) ?? target.channel) === "discord" &&
          isDiscordExecApprovalClientEnabled({ cfg, accountId: target.accountId }),
        buildPluginPendingPayload: ({ cfg, request, target, nowMs }) => {
          const text = formatDiscordApprovalPreview(
            buildPluginApprovalRequestMessage(request, nowMs),
            10_000,
          );
          const execApproval = {
            approvalId: request.id,
            approvalSlug: request.id.slice(0, 8),
            allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
          };
          const normalizedChannel = normalizeMessageChannel(target.channel) ?? target.channel;
          const interactiveEnabled =
            normalizedChannel === "discord" &&
            isDiscordExecApprovalClientEnabled({ cfg, accountId: target.accountId });
          if (!interactiveEnabled) {
            return {
              text,
              channelData: {
                execApproval,
              },
            };
          }
          return {
            text,
            channelData: {
              execApproval,
              discord: {
                components: buildDiscordPluginPendingComponentSpec({ request }),
              },
            },
          };
        },
        buildPluginResolvedPayload: ({ resolved }) => {
          const componentSpec = buildDiscordPluginResolvedComponentSpec({ resolved });
          const text = formatDiscordApprovalPreview(
            buildPluginApprovalResolvedMessage(resolved),
            10_000,
          );
          return componentSpec
            ? {
                text,
                channelData: {
                  discord: {
                    components: componentSpec,
                  },
                },
              }
            : { text };
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) => listDiscordDirectoryPeersFromConfig(params),
        listGroups: async (params) => listDiscordDirectoryGroupsFromConfig(params),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: () => getDiscordRuntime().channel.discord,
          listPeersLive: (runtime) => runtime.listDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listDirectoryGroupsLive,
        }),
      }),
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
          const account = resolveDiscordAccount({ cfg, accountId });
          if (kind === "group") {
            return resolveTargetsWithOptionalToken({
              token: account.token,
              inputs,
              missingTokenNote: "missing Discord token",
              resolveWithToken: ({ token, inputs }) =>
                getDiscordRuntime().channel.discord.resolveChannelAllowlist({
                  token,
                  entries: inputs,
                }),
              mapResolved: (entry) => ({
                input: entry.input,
                resolved: entry.resolved,
                id: entry.channelId ?? entry.guildId,
                name:
                  entry.channelName ??
                  entry.guildName ??
                  (entry.guildId && !entry.channelId ? entry.guildId : undefined),
                note: entry.note,
              }),
            });
          }
          return resolveTargetsWithOptionalToken({
            token: account.token,
            inputs,
            missingTokenNote: "missing Discord token",
            resolveWithToken: ({ token, inputs }) =>
              getDiscordRuntime().channel.discord.resolveUserAllowlist({
                token,
                entries: inputs,
              }),
            mapResolved: (entry) => ({
              input: entry.input,
              resolved: entry.resolved,
              id: entry.id,
              name: entry.name,
              note: entry.note,
            }),
          });
        },
      },
      actions: discordMessageActions,
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeDiscordAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchDiscordAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
      },
      status: createComputedAccountStatusAdapter<ResolvedDiscordAccount, DiscordProbe, unknown>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastEventAt: null,
        }),
        collectStatusIssues: collectDiscordStatusIssues,
        buildChannelSummary: ({ snapshot }) =>
          buildTokenChannelStatusSummary(snapshot, { includeMode: false }),
        probeAccount: async ({ account, timeoutMs }) =>
          (await loadDiscordProbeRuntime()).probeDiscord(account.token, timeoutMs, {
            includeApplication: true,
          }),
        formatCapabilitiesProbe: ({ probe }) => {
          const discordProbe = probe as DiscordProbe | undefined;
          const lines = [];
          if (discordProbe?.bot?.username) {
            const botId = discordProbe.bot.id ? ` (${discordProbe.bot.id})` : "";
            lines.push({ text: `Bot: @${discordProbe.bot.username}${botId}` });
          }
          if (discordProbe?.application?.intents) {
            lines.push({
              text: `Intents: ${formatDiscordIntents(discordProbe.application.intents)}`,
            });
          }
          return lines;
        },
        buildCapabilitiesDiagnostics: async ({ account, timeoutMs, target }) => {
          if (!target?.trim()) {
            return undefined;
          }
          const parsedTarget = parseDiscordTarget(target.trim(), { defaultKind: "channel" });
          const details: Record<string, unknown> = {
            target: {
              raw: target,
              normalized: parsedTarget?.normalized,
              kind: parsedTarget?.kind,
              channelId: parsedTarget?.kind === "channel" ? parsedTarget.id : undefined,
            },
          };
          if (!parsedTarget || parsedTarget.kind !== "channel") {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Target looks like a DM user; pass channel:<id> to audit channel permissions.",
                  tone: "error",
                },
              ],
            };
          }
          const token = account.token?.trim();
          if (!token) {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Discord bot token missing for permission audit.",
                  tone: "error",
                },
              ],
            };
          }
          try {
            const perms = await fetchChannelPermissionsDiscord(parsedTarget.id, {
              token,
              accountId: account.accountId ?? undefined,
            });
            const missingRequired = REQUIRED_DISCORD_PERMISSIONS.filter(
              (permission) => !perms.permissions.includes(permission),
            );
            details.permissions = {
              channelId: perms.channelId,
              guildId: perms.guildId,
              isDm: perms.isDm,
              channelType: perms.channelType,
              permissions: perms.permissions,
              missingRequired,
              raw: perms.raw,
            };
            return {
              details,
              lines: [
                {
                  text: `Permissions (${perms.channelId}): ${perms.permissions.length ? perms.permissions.join(", ") : "none"}`,
                },
                missingRequired.length > 0
                  ? { text: `Missing required: ${missingRequired.join(", ")}`, tone: "warn" }
                  : { text: "Missing required: none", tone: "success" },
              ],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            details.permissions = { channelId: parsedTarget.id, error: message };
            return {
              details,
              lines: [{ text: `Permissions: ${message}`, tone: "error" }],
            };
          }
        },
        auditAccount: async ({ account, timeoutMs, cfg }) => {
          const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
            cfg,
            accountId: account.accountId,
          });
          if (!channelIds.length && unresolvedChannels === 0) {
            return undefined;
          }
          const botToken = account.token?.trim();
          if (!botToken) {
            return {
              ok: unresolvedChannels === 0,
              checkedChannels: 0,
              unresolvedChannels,
              channels: [],
              elapsedMs: 0,
            };
          }
          const audit = await auditDiscordChannelPermissions({
            token: botToken,
            accountId: account.accountId,
            channelIds,
            timeoutMs,
          });
          return { ...audit, unresolvedChannels };
        },
        resolveAccountSnapshot: ({ account, runtime, probe, audit }) => {
          const configured =
            resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim());
          const app = runtime?.application ?? (probe as { application?: unknown })?.application;
          const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured,
            extra: {
              ...projectCredentialSnapshotFields(account),
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              application: app ?? undefined,
              bot: bot ?? undefined,
              audit,
            },
          };
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const token = account.token.trim();
          let discordBotLabel = "";
          try {
            const probe = await (
              await loadDiscordProbeRuntime()
            ).probeDiscord(token, 2500, {
              includeApplication: true,
            });
            const username = probe.ok ? probe.bot?.username?.trim() : null;
            if (username) {
              discordBotLabel = ` (@${username})`;
            }
            ctx.setStatus({
              accountId: account.accountId,
              bot: probe.bot,
              application: probe.application,
            });
            const messageContent = probe.application?.intents?.messageContent;
            if (messageContent === "disabled") {
              ctx.log?.warn(
                `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
              );
            } else if (messageContent === "limited") {
              ctx.log?.info(
                `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
              );
            }
          } catch (err) {
            if (getDiscordRuntime().logging.shouldLogVerbose()) {
              ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
            }
          }
          ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
          return (await loadDiscordProviderRuntime()).monitorDiscordProvider({
            token,
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
            historyLimit: account.config.historyLimit,
            setStatus: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
          });
        },
      },
    },
    pairing: {
      text: {
        idLabel: "discordUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(discord|user):/i),
        notify: async ({ id, message }) => {
          await getDiscordRuntime().channel.discord.sendMessageDiscord(`user:${id}`, message);
        },
      },
    },
    security: {
      resolveDmPolicy: resolveDiscordDmPolicy,
      collectWarnings: collectDiscordSecurityWarnings,
    },
    threading: {
      topLevelReplyToMode: "discord",
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: null,
        textChunkLimit: 2000,
        pollMaxOptions: 10,
        resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
      },
      attachedResults: {
        channel: "discord",
        sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent }) => {
          const send =
            resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
            getDiscordRuntime().channel.discord.sendMessageDiscord;
          return await send(to, text, {
            verbose: false,
            cfg,
            replyTo: replyToId ?? undefined,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
          });
        },
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          accountId,
          deps,
          replyToId,
          silent,
        }) => {
          const send =
            resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
            getDiscordRuntime().channel.discord.sendMessageDiscord;
          return await send(to, text, {
            verbose: false,
            cfg,
            mediaUrl,
            mediaLocalRoots,
            replyTo: replyToId ?? undefined,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
          });
        },
        sendPoll: async ({ cfg, to, poll, accountId, silent }) =>
          await getDiscordRuntime().channel.discord.sendPollDiscord(to, poll, {
            cfg,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
          }),
      },
    },
  });
