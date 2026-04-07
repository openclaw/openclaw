import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createMessageToolCardSchema } from "openclaw/plugin-sdk/channel-actions";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  projectConfigWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import {
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelMessageActionName,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./channel-api.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsDirectoryAdapter } from "./directory.js";
import { collectMSTeamsMutableAllowlistWarnings } from "./doctor.js";
import { formatUnknownError } from "./errors.js";
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
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
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
  blurb: "Teams SDK; enterprise support.",
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

const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy,
  collect: ({ groupPolicy }) =>
    groupPolicy === "open"
      ? [
          '- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.',
        ]
      : [],
});

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

const resolveMSTeamsChannelConfig = (cfg: OpenClawConfig) => ({
  allowFrom: cfg.channels?.msteams?.allowFrom,
  defaultTo: cfg.channels?.msteams?.defaultTo,
});

const msteamsConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  {
    allowFrom?: Array<string | number>;
    defaultTo?: string;
  }
>({
  sectionKey: "msteams",
  resolveAccount: (cfg) => ({
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: cfg.channels?.msteams?.enabled !== false,
    configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
  }),
  resolveAccessorAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

function jsonActionResult(data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
    details: data,
  };
}

function jsonMSTeamsActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ channel: "msteams", action, ...data });
}

function jsonMSTeamsOkActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ ok: true, channel: "msteams", action, ...data });
}

function jsonMSTeamsConversationResult(conversationId: string | undefined) {
  return jsonActionResultWithDetails(
    {
      ok: true,
      channel: "msteams",
      conversationId,
    },
    { ok: true, channel: "msteams" },
  );
}

function jsonActionResultWithDetails(
  contentData: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(contentData) }],
    details,
  };
}

const MSTEAMS_REACTION_TYPES = ["like", "heart", "laugh", "surprised", "sad", "angry"] as const;

function actionError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
  };
}

function resolveActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
): string {
  return typeof params.to === "string"
    ? params.to.trim()
    : typeof params.target === "string"
      ? params.target.trim()
      : (currentChannelId?.trim() ?? "");
}

function resolveActionMessageId(params: Record<string, unknown>): string {
  return typeof params.messageId === "string" ? params.messageId.trim() : "";
}

function resolveActionPinnedMessageId(params: Record<string, unknown>): string {
  return typeof params.pinnedMessageId === "string"
    ? params.pinnedMessageId.trim()
    : typeof params.messageId === "string"
      ? params.messageId.trim()
      : "";
}

function resolveActionQuery(params: Record<string, unknown>): string {
  return typeof params.query === "string" ? params.query.trim() : "";
}

function resolveActionContent(params: Record<string, unknown>): string {
  return typeof params.text === "string"
    ? params.text
    : typeof params.content === "string"
      ? params.content
      : typeof params.message === "string"
        ? params.message
        : "";
}

function resolveActionUploadFilePath(params: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "path", "media"] as const) {
    if (typeof params[key] === "string") {
      const value = params[key];
      if (value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function resolveRequiredActionTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): string | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  if (!to) {
    return actionError(`${params.actionLabel} requires a target (to).`);
  }
  return to;
}

function resolveRequiredActionMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): { to: string; messageId: string } | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  const messageId = resolveActionMessageId(params.toolParams);
  if (!to || !messageId) {
    return actionError(`${params.actionLabel} requires a target (to) and messageId.`);
  }
  return { to, messageId };
}

function resolveRequiredActionPinnedMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
}): { to: string; pinnedMessageId: string } | ReturnType<typeof actionError> {
  const to = resolveActionTarget(params.toolParams, params.currentChannelId);
  const pinnedMessageId = resolveActionPinnedMessageId(params.toolParams);
  if (!to || !pinnedMessageId) {
    return actionError(`${params.actionLabel} requires a target (to) and pinnedMessageId.`);
  }
  return { to, pinnedMessageId };
}

async function runWithRequiredActionTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (to: string) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveRequiredActionTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
  });
  if (typeof to !== "string") {
    return to;
  }
  return await params.run(to);
}

async function runWithRequiredActionMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (target: { to: string; messageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionMessageTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

async function runWithRequiredActionPinnedMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  run: (target: { to: string; pinnedMessageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionPinnedMessageTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

function describeMSTeamsMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabled =
    cfg.channels?.msteams?.enabled !== false &&
    Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
  return {
    actions: enabled
      ? ([
          "upload-file",
          "poll",
          "edit",
          "delete",
          "pin",
          "unpin",
          "list-pins",
          "read",
          "react",
          "reactions",
          "search",
          "member-info",
          "channel-list",
          "channel-info",
        ] satisfies ChannelMessageActionName[])
      : [],
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

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
  createChatChannelPlugin({
    base: {
      id: "msteams",
      meta: {
        ...meta,
        aliases: [...meta.aliases],
      },
      setupWizard: msteamsSetupWizard,
      capabilities: {
        chatTypes: ["direct", "channel", "thread"],
        polls: true,
        threads: true,
        media: true,
      },
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
          "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
        ],
      },
      groups: {
        resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
      },
      reload: { configPrefixes: ["channels.msteams"] },
      configSchema: MSTeamsChannelConfigSchema,
      config: {
        ...msteamsConfigAdapter,
        isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
          }),
      },
      auth: msTeamsApprovalAuth,
      doctor: {
        dmAllowFromMode: "topOnly",
        groupModel: "hybrid",
        groupAllowFromFallbackToAllowFrom: false,
        warnOnEmptyGroupSenderAllowlist: true,
        collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
      },
      setup: msteamsSetupAdapter,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
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
      directory: msteamsDirectoryAdapter,
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
              runtime.error?.(`msteams resolve failed: ${formatUnknownError(err)}`);
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
            return await runWithRequiredActionTarget({
              actionLabel: "Card send",
              toolParams: ctx.params,
              run: async (to) => {
                const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await sendAdaptiveCardMSTeams({
                  cfg: ctx.cfg,
                  to,
                  card,
                });
                return jsonActionResultWithDetails(
                  {
                    ok: true,
                    channel: "msteams",
                    messageId: result.messageId,
                    conversationId: result.conversationId,
                  },
                  { ok: true, channel: "msteams", messageId: result.messageId },
                );
              },
            });
          }
          if (ctx.action === "upload-file") {
            const mediaUrl = resolveActionUploadFilePath(ctx.params);
            if (!mediaUrl) {
              return actionError("Upload-file requires media, filePath, or path.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "Upload-file",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await sendMessageMSTeams({
                  cfg: ctx.cfg,
                  to,
                  text: resolveActionContent(ctx.params),
                  mediaUrl,
                  filename:
                    normalizeOptionalString(ctx.params.filename) ??
                    normalizeOptionalString(ctx.params.title),
                  mediaLocalRoots: ctx.mediaLocalRoots,
                  mediaReadFile: ctx.mediaReadFile,
                });
                return jsonActionResultWithDetails(
                  {
                    ok: true,
                    channel: "msteams",
                    action: "upload-file",
                    messageId: result.messageId,
                    conversationId: result.conversationId,
                    ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
                  },
                  {
                    ok: true,
                    channel: "msteams",
                    messageId: result.messageId,
                    ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
                  },
                );
              },
            });
          }
          if (ctx.action === "edit") {
            const content = resolveActionContent(ctx.params);
            if (!content) {
              return actionError("Edit requires content.");
            }
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Edit",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { editMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await editMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  activityId: target.messageId,
                  text: content,
                });
                return jsonMSTeamsConversationResult(result.conversationId);
              },
            });
          }

          if (ctx.action === "delete") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Delete",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { deleteMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await deleteMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  activityId: target.messageId,
                });
                return jsonMSTeamsConversationResult(result.conversationId);
              },
            });
          }

          if (ctx.action === "read") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Read",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { getMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const message = await getMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsOkActionResult("read", { message });
              },
            });
          }

          if (ctx.action === "pin") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Pin",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { pinMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await pinMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsActionResult("pin", result);
              },
            });
          }

          if (ctx.action === "unpin") {
            return await runWithRequiredActionPinnedMessageTarget({
              actionLabel: "Unpin",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await unpinMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  pinnedMessageId: target.pinnedMessageId,
                });
                return jsonMSTeamsActionResult("unpin", result);
              },
            });
          }

          if (ctx.action === "list-pins") {
            return await runWithRequiredActionTarget({
              actionLabel: "List-pins",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await listPinsMSTeams({ cfg: ctx.cfg, to });
                return jsonMSTeamsOkActionResult("list-pins", result);
              },
            });
          }

          if (ctx.action === "react") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "React",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
                const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
                if (!emoji) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text" as const,
                        text: `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`,
                      },
                    ],
                    details: {
                      error: "React requires an emoji (reaction type).",
                      validTypes: [...MSTEAMS_REACTION_TYPES],
                    },
                  };
                }
                if (remove) {
                  const { unreactMessageMSTeams } = await loadMSTeamsChannelRuntime();
                  const result = await unreactMessageMSTeams({
                    cfg: ctx.cfg,
                    to: target.to,
                    messageId: target.messageId,
                    reactionType: emoji,
                  });
                  return jsonMSTeamsActionResult("react", {
                    removed: true,
                    reactionType: emoji,
                    ...result,
                  });
                }
                const { reactMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await reactMessageMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  messageId: target.messageId,
                  reactionType: emoji,
                });
                return jsonMSTeamsActionResult("react", {
                  reactionType: emoji,
                  ...result,
                });
              },
            });
          }

          if (ctx.action === "reactions") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Reactions",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const { listReactionsMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await listReactionsMSTeams({
                  cfg: ctx.cfg,
                  to: target.to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsOkActionResult("reactions", result);
              },
            });
          }

          if (ctx.action === "search") {
            return await runWithRequiredActionTarget({
              actionLabel: "Search",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const query = resolveActionQuery(ctx.params);
                if (!query) {
                  return actionError("Search requires a target (to) and query.");
                }
                const limit = typeof ctx.params.limit === "number" ? ctx.params.limit : undefined;
                const from =
                  typeof ctx.params.from === "string" ? ctx.params.from.trim() : undefined;
                const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await searchMessagesMSTeams({
                  cfg: ctx.cfg,
                  to,
                  query,
                  from: from || undefined,
                  limit,
                });
                return jsonMSTeamsOkActionResult("search", result);
              },
            });
          }

          if (ctx.action === "member-info") {
            const userId = typeof ctx.params.userId === "string" ? ctx.params.userId.trim() : "";
            if (!userId) {
              return actionError("member-info requires a userId.");
            }
            const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await getMemberInfoMSTeams({ cfg: ctx.cfg, userId });
            return jsonMSTeamsOkActionResult("member-info", result);
          }

          if (ctx.action === "channel-list") {
            const teamId = typeof ctx.params.teamId === "string" ? ctx.params.teamId.trim() : "";
            if (!teamId) {
              return actionError("channel-list requires a teamId.");
            }
            const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await listChannelsMSTeams({ cfg: ctx.cfg, teamId });
            return jsonMSTeamsOkActionResult("channel-list", result);
          }

          if (ctx.action === "channel-info") {
            const teamId = typeof ctx.params.teamId === "string" ? ctx.params.teamId.trim() : "";
            const channelId =
              typeof ctx.params.channelId === "string" ? ctx.params.channelId.trim() : "";
            if (!teamId || !channelId) {
              return actionError("channel-info requires teamId and channelId.");
            }
            const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await getChannelInfoMSTeams({
              cfg: ctx.cfg,
              teamId,
              channelId,
            });
            return jsonMSTeamsOkActionResult("channel-info", {
              channelInfo: result.channel,
            });
          }

          // Return null to fall through to default handler
          return null as never;
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedMSTeamsAccount, ProbeMSTeamsResult>({
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
            if (!graph.ok) {
              lines.push({ text: `Graph: ${graph.error ?? "failed"}`, tone: "error" });
            } else if (roles.length > 0 || scopes.length > 0) {
              if (roles.length > 0) {
                lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
              }
              if (scopes.length > 0) {
                lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
              }
            } else if (graph.ok) {
              lines.push({ text: "Graph: ok" });
            }
          }
          return lines;
        },
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            port: runtime?.port ?? null,
          },
        }),
      }),
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
    },
    security: {
      collectWarnings: projectConfigWarningCollector<{ cfg: OpenClawConfig }>(
        collectMSTeamsSecurityWarnings,
      ),
    },
    pairing: {
      text: {
        idLabel: "msteamsUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
        notify: async ({ cfg, id, message }) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          await sendMessageMSTeams({
            cfg,
            to: id,
            text: message,
          });
        },
      },
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) => ({
        currentChannelId: normalizeOptionalString(context.To),
        currentThreadTs: context.ReplyToId,
        hasRepliedRef,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      pollMaxOptions: 12,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadMSTeamsChannelRuntime,
        sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
        sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
        sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll },
      }),
    },
  });
