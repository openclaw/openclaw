import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedAccountConfigAccessors,
  createTopLevelChannelConfigBase,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { collectAllowlistProviderRestrictSendersWarnings } from "openclaw/plugin-sdk/channel-policy";
import { createMessageToolCardSchema } from "openclaw/plugin-sdk/channel-runtime";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelMessageActionName, ChannelPlugin, OpenClawConfig } from "../runtime-api.js";
import {
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  buildChannelConfigSchema,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  MSTeamsConfigSchema,
  PAIRING_APPROVED_MESSAGE,
} from "../runtime-api.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import type { ProbeMSTeamsResult } from "./probe.js";
import {
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";
import { msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";
import { resolveMSTeamsCredentials } from "./token.js";

type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Bot Framework; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Channel.ReadBasic.All": "channel list",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
  "Sites.Read.All": "files (SharePoint)",
  "Files.Read.All": "files (OneDrive)",
};

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

const resolveMSTeamsChannelConfig = (cfg: OpenClawConfig) => ({
  allowFrom: cfg.channels?.msteams?.allowFrom,
  defaultTo: cfg.channels?.msteams?.defaultTo,
});

const msteamsConfigBase = createTopLevelChannelConfigBase<ResolvedMSTeamsAccount>({
  sectionKey: "msteams",
  resolveAccount: (cfg) => ({
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: cfg.channels?.msteams?.enabled !== false,
    configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
  }),
});

const msteamsConfigAccessors = createScopedAccountConfigAccessors<{
  allowFrom?: Array<string | number>;
  defaultTo?: string;
}>({
  resolveAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

function describeMSTeamsMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabled =
    cfg.channels?.msteams?.enabled !== false &&
    Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
  return {
    actions: enabled ? (["poll"] satisfies ChannelMessageActionName[]) : [],
    capabilities: enabled ? ["cards"] : [],
    schema: enabled
      ? {
          properties: {
            card: createMessageToolCardSchema(),
          },
        }
      : null,
  };
}

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
  },
  setupWizard: msteamsSetupWizard,
  pairing: {
    idLabel: "msteamsUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(msteams|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
      await sendMessageMSTeams({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
      "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
    ],
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToId,
      hasRepliedRef,
    }),
  },
  groups: {
    resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: buildChannelConfigSchema(MSTeamsConfigSchema),
  config: {
    ...msteamsConfigBase,
    isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    ...msteamsConfigAccessors,
  },
  security: {
    collectWarnings: ({ cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.msteams !== undefined,
        configuredGroupPolicy: cfg.channels?.msteams?.groupPolicy,
        surface: "MS Teams groups",
        openScope: "any member",
        groupPolicyPath: "channels.msteams.groupPolicy",
        groupAllowFromPath: "channels.msteams.groupAllowFrom",
      });
    },
  },
  setup: msteamsSetupAdapter,
  messaging: {
    normalizeTarget: normalizeMSTeamsMessagingTarget,
    resolveOutboundSessionRoute: (params) => resolveMSTeamsOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^conversation:/i.test(trimmed)) {
          return true;
        }
        if (/^user:/i.test(trimmed)) {
          // Only treat as ID if the value after user: looks like a UUID
          const id = trimmed.slice("user:".length).trim();
          return /^[0-9a-fA-F-]{16,}$/.test(id);
        }
        return trimmed.includes("@thread");
      },
      hint: "<conversationId|user:ID|conversation:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of cfg.channels?.msteams?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") {
          ids.add(trimmed);
        }
      }
      for (const userId of Object.keys(cfg.channels?.msteams?.dms ?? {})) {
        const trimmed = userId.trim();
        if (trimmed) {
          ids.add(trimmed);
        }
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => normalizeMSTeamsMessagingTarget(raw) ?? raw)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("user:")) {
            return raw;
          }
          if (lowered.startsWith("conversation:")) {
            return raw;
          }
          return `user:${raw}`;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const team of Object.values(cfg.channels?.msteams?.teams ?? {})) {
        for (const channelId of Object.keys(team.channels ?? {})) {
          const trimmed = channelId.trim();
          if (trimmed && trimmed !== "*") {
            ids.add(trimmed);
          }
        }
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => raw.replace(/^conversation:/i, "").trim())
        .map((id) => `conversation:${id}`)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
    listPeersLive: async ({ cfg, query, limit }) =>
      (await loadMSTeamsChannelRuntime()).listMSTeamsDirectoryPeersLive({ cfg, query, limit }),
    listGroupsLive: async ({ cfg, query, limit }) =>
      (await loadMSTeamsChannelRuntime()).listMSTeamsDirectoryGroupsLive({ cfg, query, limit }),
  },
  resolver: {
    resolveTargets: async ({ cfg, inputs, kind, runtime }) => {
      const results = inputs.map((input) => ({
        input,
        resolved: false,
        id: undefined as string | undefined,
        name: undefined as string | undefined,
        note: undefined as string | undefined,
      }));
      type ResolveTargetResultEntry = (typeof results)[number];
      type PendingTargetEntry = { input: string; query: string; index: number };

      const stripPrefix = (value: string) => normalizeMSTeamsUserInput(value);
      const markPendingLookupFailed = (pending: PendingTargetEntry[]) => {
        pending.forEach(({ index }) => {
          const entry = results[index];
          if (entry) {
            entry.note = "lookup failed";
          }
        });
      };
      const resolvePending = async <T>(
        pending: PendingTargetEntry[],
        resolveEntries: (entries: string[]) => Promise<T[]>,
        applyResolvedEntry: (target: ResolveTargetResultEntry, entry: T) => void,
      ) => {
        if (pending.length === 0) {
          return;
        }
        try {
          const resolved = await resolveEntries(pending.map((entry) => entry.query));
          resolved.forEach((entry, idx) => {
            const target = results[pending[idx]?.index ?? -1];
            if (!target) {
              return;
            }
            applyResolvedEntry(target, entry);
          });
        } catch (err) {
          runtime.error?.(`msteams resolve failed: ${String(err)}`);
          markPendingLookupFailed(pending);
        }
      };

      if (kind === "user") {
        const pending: PendingTargetEntry[] = [];
        results.forEach((entry, index) => {
          const trimmed = entry.input.trim();
          if (!trimmed) {
            entry.note = "empty input";
            return;
          }
          const cleaned = stripPrefix(trimmed);
          if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
            entry.resolved = true;
            entry.id = cleaned;
            return;
          }
          pending.push({ input: entry.input, query: cleaned, index });
        });

        await resolvePending(
          pending,
          (entries) => resolveMSTeamsUserAllowlist({ cfg, entries }),
          (target, entry) => {
            target.resolved = entry.resolved;
            target.id = entry.id;
            target.name = entry.name;
            target.note = entry.note;
          },
        );

        return results;
      }

      const pending: PendingTargetEntry[] = [];
      results.forEach((entry, index) => {
        const trimmed = entry.input.trim();
        if (!trimmed) {
          entry.note = "empty input";
          return;
        }
        const conversationId = parseMSTeamsConversationId(trimmed);
        if (conversationId !== null) {
          entry.resolved = Boolean(conversationId);
          entry.id = conversationId || undefined;
          entry.note = conversationId ? "conversation id" : "empty conversation id";
          return;
        }
        const parsed = parseMSTeamsTeamChannelInput(trimmed);
        if (!parsed.team) {
          entry.note = "missing team";
          return;
        }
        const query = parsed.channel ? `${parsed.team}/${parsed.channel}` : parsed.team;
        pending.push({ input: entry.input, query, index });
      });

      await resolvePending(
        pending,
        (entries) => resolveMSTeamsChannelAllowlist({ cfg, entries }),
        (target, entry) => {
          if (!entry.resolved || !entry.teamId) {
            target.resolved = false;
            target.note = entry.note;
            return;
          }
          target.resolved = true;
          if (entry.channelId) {
            target.id = `${entry.teamId}/${entry.channelId}`;
            target.name =
              entry.channelName && entry.teamName
                ? `${entry.teamName}/${entry.channelName}`
                : (entry.channelName ?? entry.teamName);
          } else {
            target.id = entry.teamId;
            target.name = entry.teamName;
            target.note = "team id";
          }
          if (entry.note) {
            target.note = entry.note;
          }
        },
      );

      return results;
    },
  },
  actions: {
    describeMessageTool: describeMSTeamsMessageTool,
    handleAction: async (ctx) => {
      // Handle send action with card parameter
      if (ctx.action === "send" && ctx.params.card) {
        const card = ctx.params.card as Record<string, unknown>;
        const to =
          typeof ctx.params.to === "string"
            ? ctx.params.to.trim()
            : typeof ctx.params.target === "string"
              ? ctx.params.target.trim()
              : "";
        if (!to) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Card send requires a target (to)." }],
            details: { error: "Card send requires a target (to)." },
          };
        }
        const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
        const result = await sendAdaptiveCardMSTeams({
          cfg: ctx.cfg,
          to,
          card,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                channel: "msteams",
                messageId: result.messageId,
                conversationId: result.conversationId,
              }),
            },
          ],
          details: { ok: true, channel: "msteams", messageId: result.messageId },
        };
      }
      // Return null to fall through to default handler
      return null as never;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMSTeamsRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    sendText: async (params) =>
      (await loadMSTeamsChannelRuntime()).msteamsOutbound.sendText!(params),
    sendMedia: async (params) =>
      (await loadMSTeamsChannelRuntime()).msteamsOutbound.sendMedia!(params),
    sendPoll: async (params) =>
      (await loadMSTeamsChannelRuntime()).msteamsOutbound.sendPoll!(params),
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, {
        port: snapshot.port ?? null,
      }),
    probeAccount: async ({ cfg }) =>
      await (await loadMSTeamsChannelRuntime()).probeMSTeams(cfg.channels?.msteams),
    formatCapabilitiesProbe: ({ probe }) => {
      const teamsProbe = probe as ProbeMSTeamsResult | undefined;
      const lines: Array<{ text: string; tone?: "error" }> = [];
      const appId = typeof teamsProbe?.appId === "string" ? teamsProbe.appId.trim() : "";
      if (appId) {
        lines.push({ text: `App: ${appId}` });
      }
      const graph = teamsProbe?.graph;
      if (graph) {
        const roles = Array.isArray(graph.roles)
          ? graph.roles.map((role) => String(role).trim()).filter(Boolean)
          : [];
        const scopes = Array.isArray(graph.scopes)
          ? graph.scopes.map((scope) => String(scope).trim()).filter(Boolean)
          : [];
        const formatPermission = (permission: string) => {
          const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
          return hint ? `${permission} (${hint})` : permission;
        };
        if (graph.ok === false) {
          lines.push({ text: `Graph: ${graph.error ?? "failed"}`, tone: "error" });
        } else if (roles.length > 0 || scopes.length > 0) {
          if (roles.length > 0) {
            lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
          }
          if (scopes.length > 0) {
            lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
          }
        } else if (graph.ok === true) {
          lines.push({ text: "Graph: ok" });
        }
      }
      return lines;
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      ...buildRuntimeAccountStatusSnapshot({ runtime, probe }),
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorMSTeamsProvider } = await import("./index.js");
      const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting provider (port ${port})`);
      return monitorMSTeamsProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
