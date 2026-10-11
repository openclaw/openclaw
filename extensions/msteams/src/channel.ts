import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  createChannelMessageAdapterFromOutbound,
  createRuntimeOutboundDelegates,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../runtime-api.js";
import {
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "../runtime-api.js";
import {
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
} from "./accounts.js";
import { resolveActionContent, resolveActionUploadFilePath } from "./action-params.js";
import {
  actionError,
  jsonActionResult,
  jsonMSTeamsActionResult,
  jsonMSTeamsConversationResult,
  jsonMSTeamsOkActionResult,
} from "./action-results.js";
import {
  extractMSTeamsToolSendResult,
  msteamsContextTargetsMatch,
  resolveMSTeamsActionMessage,
  resolveMSTeamsAutoThreadId,
} from "./action-threading.js";
import {
  isMSTeamsNativeApprovalClientEnabled,
  msTeamsApprovalCapability,
  shouldSuppressLocalMSTeamsExecApprovalPrompt,
} from "./approval-native.js";
import { collectMSTeamsSecurityWarnings, type ResolvedMSTeamsAccount } from "./channel-config.js";
import { describeMSTeamsMessageTool } from "./channel-message-tool.js";
import { msteamsSetupPlugin } from "./channel.setup.js";
import { msteamsDoctor } from "./doctor.js";
import {
  MSTEAMS_GROUP_MANAGEMENT_ACTIONS,
  withMSTeamsGraphMutationCurrentness,
} from "./graph-action-context.js";
import { msteamsOutboundConfig } from "./outbound-config.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import type { ProbeMSTeamsResult } from "./probe.js";
import {
  assertMSTeamsReadTargetAllowed,
  assertMSTeamsTeamEnumerationAllowed,
  isCurrentMSTeamsReadTarget,
} from "./read-policy.js";
import {
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  looksLikeMSTeamsTargetId,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { inferMSTeamsTargetChatType, resolveMSTeamsOutboundSessionRoute } from "./session-route.js";
const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Channel.ReadBasic.All": "channel list",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
  "Sites.Read.All": "files (SharePoint)",
  "Files.Read.All": "files (OneDrive)",
};

const collectMSTeamsSecurityFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectMSTeamsSecurityWarnings,
  checkId: "channels.msteams.groups.open",
  severity: "warn",
  title: "MS Teams security warning",
});

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

const MSTEAMS_REACTION_TYPES = ["like", "heart", "laugh", "surprised", "sad", "angry"] as const;

function requireMSTeamsGroupManagementAuthorization(ctx: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): ReturnType<typeof actionError> | null {
  if (ctx.senderIsOwner === true || ctx.gatewayClientScopes?.includes("operator.admin")) {
    return null;
  }
  return actionError(
    "Microsoft Teams group management requires an owner or operator.admin requester.",
  );
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

function resolveGraphActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
  currentGraphChannelId?: string | null,
  currentChatType?: "direct" | "group" | "channel" | null,
): string {
  const explicitTarget = resolveActionTarget(params);
  const currentChannelTarget = currentChannelId?.trim();
  const currentGraphTarget = currentGraphChannelId?.trim();
  if (explicitTarget) {
    // Current-conversation aliases need the prepared Graph route, including
    // targets materialized by core before plugin dispatch.
    if (
      currentChatType === "channel" &&
      currentGraphTarget &&
      currentChannelTarget &&
      msteamsContextTargetsMatch(normalizeMSTeamsMessagingTarget(explicitTarget) ?? "", {
        currentChannelId: currentChannelTarget,
      })
    ) {
      return currentGraphTarget;
    }
    return explicitTarget;
  }
  if (currentGraphTarget) {
    return currentGraphTarget;
  }
  return currentChatType === "channel" ? "" : (currentChannelTarget ?? "");
}

const msteamsChannelOutbound: ChannelOutboundAdapter = {
  ...msteamsOutboundConfig,
  shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
    shouldSuppressLocalMSTeamsExecApprovalPrompt({ cfg, accountId, payload, hint }),
  ...createRuntimeOutboundDelegates({
    getRuntime: loadMSTeamsChannelRuntime,
    renderPresentation: { resolve: (runtime) => runtime.msteamsOutbound.renderPresentation },
    sendPayload: { resolve: (runtime) => runtime.msteamsOutbound.sendPayload },
    sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
    sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
    sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll },
  }),
};

const msteamsMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "msteams",
  outbound: msteamsChannelOutbound,
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
      nativeStreaming: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        previewReceipt: true,
      },
    },
  },
});

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
  createChatChannelPlugin({
    base: {
      ...msteamsSetupPlugin,
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
      approvalCapability: msTeamsApprovalCapability,
      doctor: msteamsDoctor,
      messaging: {
        targetPrefixes: ["msteams", "teams"],
        directTargetStyle: "user-prefixed",
        normalizeTarget: normalizeMSTeamsMessagingTarget,
        inferTargetChatType: ({ to }) => inferMSTeamsTargetChatType(to),
        resolveOutboundSessionRoute: resolveMSTeamsOutboundSessionRoute,
        targetResolver: {
          looksLikeId: looksLikeMSTeamsTargetId,
          hint: "<conversationId|user:ID|conversation:ID>",
        },
      },
      message: msteamsMessageAdapter,
      directory: createChannelDirectoryAdapter({
        ...msteamsDirectoryContractPlugin.directory,
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadMSTeamsChannelRuntime,
          listPeersLive: (runtime) => runtime.listMSTeamsDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listMSTeamsDirectoryGroupsLive,
        }),
      }),
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
          const results = inputs.map((input) => ({
            input,
            resolved: false,
            id: undefined as string | undefined,
            name: undefined as string | undefined,
            note: undefined as string | undefined,
          }));
          type ResolveTargetResultEntry = (typeof results)[number];
          type PendingTargetEntry = { query: string; index: number };
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
              for (const { index } of pending) {
                results[index]!.note = "lookup failed";
              }
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
              const cleaned = normalizeMSTeamsUserInput(trimmed);
              if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
                entry.resolved = true;
                entry.id = cleaned;
                return;
              }
              pending.push({ query: cleaned, index });
            });

            await resolvePending(
              pending,
              (entries) => resolveMSTeamsUserAllowlist({ cfg, accountId, entries }),
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
            pending.push({ query, index });
          });

          await resolvePending(
            pending,
            (entries) => resolveMSTeamsChannelAllowlist({ cfg, accountId, entries }),
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
        providerOwnedReadGates: true,
        readAuthorityActions: [
          "read",
          "search",
          "reactions",
          "list-pins",
          "member-info",
          "channel-info",
          "channel-list",
        ],
        describeMessageTool: describeMSTeamsMessageTool,
        extractToolSendResult: ({ result }) => extractMSTeamsToolSendResult(result),
        requiresTrustedRequesterSender: ({ action, toolContext }) =>
          normalizeOptionalString(toolContext?.currentChannelProvider)?.toLowerCase() ===
            "msteams" && MSTEAMS_GROUP_MANAGEMENT_ACTIONS.has(action),
        handleAction: withMSTeamsGraphMutationCurrentness(async (ctx) => {
          if (MSTEAMS_GROUP_MANAGEMENT_ACTIONS.has(ctx.action)) {
            const authError = requireMSTeamsGroupManagementAuthorization(ctx);
            if (authError) {
              return authError;
            }
          }
          const accountId = ctx.accountId ?? resolveDefaultMSTeamsAccountId(ctx.cfg);
          const actionAccountId =
            ctx.accountId ?? (accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId);
          const actionContext = { ...ctx, accountId };
          const authorizeActionTarget = (target: string) =>
            assertMSTeamsReadTargetAllowed({ cfg: ctx.cfg, ctx: actionContext, target });
          const presentation =
            ctx.action === "send"
              ? normalizeMessagePresentation(ctx.params.presentation)
              : undefined;
          if (ctx.action === "send" && presentation) {
            const card = buildMSTeamsPresentationCard({
              presentation,
              text: resolveActionContent(ctx.params),
            });
            const to = resolveActionTarget(ctx.params);
            if (!to) {
              return actionError("Card send requires a target (to).");
            }
            const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await sendAdaptiveCardMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              card,
              assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
              onPlatformSendDispatch: ctx.onPlatformSendDispatch,
            });
            return jsonActionResult({
              ok: true,
              channel: "msteams",
              messageId: result.messageId,
              conversationId: result.conversationId,
            });
          }
          if (ctx.action === "upload-file") {
            const mediaUrl = resolveActionUploadFilePath(ctx.params);
            if (!mediaUrl) {
              return actionError("Upload-file requires media, filePath, or path.");
            }
            const to = resolveActionTarget(ctx.params, ctx.toolContext?.currentChannelId);
            if (!to) {
              return actionError("Upload-file requires a target (to).");
            }
            const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await sendMessageMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              text: resolveActionContent(ctx.params),
              mediaUrl,
              filename:
                normalizeOptionalString(ctx.params.filename) ??
                normalizeOptionalString(ctx.params.title),
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
              onPlatformSendDispatch: ctx.onPlatformSendDispatch,
            });
            return jsonActionResult({
              ok: true,
              channel: "msteams",
              action: "upload-file",
              messageId: result.messageId,
              conversationId: result.conversationId,
              ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
            });
          }
          if (ctx.action === "edit" || ctx.action === "delete") {
            const action = ctx.action;
            const content = action === "edit" ? resolveActionContent(ctx.params) : "";
            if (action === "edit" && !content) {
              return actionError("Edit requires content.");
            }
            const target = resolveActionTarget(ctx.params, ctx.toolContext?.currentChannelId);
            const messageId = normalizeOptionalString(ctx.params.messageId) ?? "";
            if (!target || !messageId) {
              return actionError(
                `${action === "edit" ? "Edit" : "Delete"} requires a target (to) and messageId.`,
              );
            }
            const to = await authorizeActionTarget(target);
            const runtime = await loadMSTeamsChannelRuntime();
            const params = { cfg: ctx.cfg, accountId: actionAccountId, to, activityId: messageId };
            const result =
              action === "edit"
                ? await runtime.editMessageMSTeams({ ...params, text: content })
                : await runtime.deleteMessageMSTeams(params);
            return jsonMSTeamsConversationResult(result.conversationId);
          }

          // Normal message-tool search/member-info use channelId as their conversation filter.
          const graphParams =
            ctx.action === "search" || ctx.action === "member-info"
              ? {
                  ...ctx.params,
                  to:
                    resolveActionTarget(ctx.params) ||
                    normalizeOptionalString(ctx.params.channelId),
                }
              : ctx.params;
          const graphTo = resolveGraphActionTarget(
            graphParams,
            ctx.toolContext?.currentChannelId,
            normalizeOptionalString(ctx.toolContext?.currentGraphChannelId) ??
              normalizeOptionalString(ctx.toolContext?.currentMessagingTarget),
            ctx.toolContext?.currentChatType,
          );

          if (ctx.action === "read" || ctx.action === "pin" || ctx.action === "reactions") {
            const action = ctx.action;
            const { messageId, threadRootId } = resolveMSTeamsActionMessage(
              ctx,
              graphTo,
              action === "reactions",
            );
            if (!graphTo || !messageId) {
              return actionError(
                `${{ read: "Read", pin: "Pin", reactions: "Reactions" }[action]} requires a target (to) and messageId.`,
              );
            }
            const to = await authorizeActionTarget(graphTo);
            const runtime = await loadMSTeamsChannelRuntime();
            const params = {
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              messageId,
              threadRootId,
            };
            if (action === "read") {
              const message = await runtime.getMessageMSTeams(params);
              return jsonMSTeamsOkActionResult(action, { message });
            }
            if (action === "pin") {
              return jsonMSTeamsActionResult(action, await runtime.pinMessageMSTeams(params));
            }
            return jsonMSTeamsOkActionResult(action, await runtime.listReactionsMSTeams(params));
          }

          if (ctx.action === "unpin") {
            const pinnedMessageId =
              typeof ctx.params.pinnedMessageId === "string"
                ? ctx.params.pinnedMessageId.trim()
                : (normalizeOptionalString(ctx.params.messageId) ?? "");
            if (!graphTo || !pinnedMessageId) {
              return actionError("Unpin requires a target (to) and pinnedMessageId.");
            }
            const to = await authorizeActionTarget(graphTo);
            const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await unpinMessageMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              pinnedMessageId,
            });
            return jsonMSTeamsActionResult("unpin", result);
          }

          if (ctx.action === "list-pins") {
            if (!graphTo) {
              return actionError("List-pins requires a target (to).");
            }
            const to = await authorizeActionTarget(graphTo);
            const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await listPinsMSTeams({ cfg: ctx.cfg, accountId: actionAccountId, to });
            return jsonMSTeamsOkActionResult("list-pins", result);
          }

          if (ctx.action === "react") {
            const { messageId, threadRootId } = resolveMSTeamsActionMessage(ctx, graphTo, true);
            if (!graphTo || !messageId) {
              return actionError("React requires a target (to) and messageId.");
            }
            const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
            const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
            if (!emoji) {
              return {
                isError: true,
                ...textResult(
                  `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`,
                  {
                    error: "React requires an emoji (reaction type).",
                    validTypes: [...MSTEAMS_REACTION_TYPES],
                  },
                ),
              };
            }
            const to = await authorizeActionTarget(graphTo);
            const runtime = await loadMSTeamsChannelRuntime();
            const react = remove ? runtime.unreactMessageMSTeams : runtime.reactMessageMSTeams;
            const result = await react({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              messageId,
              threadRootId,
              reactionType: emoji,
            });
            return jsonMSTeamsActionResult("react", {
              ...(remove ? { removed: true } : {}),
              reactionType: emoji,
              ...result,
            });
          }

          if (ctx.action === "search") {
            if (!graphTo) {
              return actionError("Search requires a target (to).");
            }
            const to = await authorizeActionTarget(graphTo);
            const query = normalizeOptionalString(ctx.params.query);
            if (!query) {
              return actionError("Search requires a target (to) and query.");
            }
            const limit = readPositiveIntegerParam(ctx.params, "limit");
            const from = typeof ctx.params.from === "string" ? ctx.params.from.trim() : undefined;
            const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await searchMessagesMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              query,
              from: from || undefined,
              limit,
            });
            return jsonMSTeamsOkActionResult("search", result);
          }

          if (ctx.action === "member-info") {
            const userId = normalizeOptionalString(ctx.params.userId) ?? "";
            if (!userId) {
              return actionError("member-info requires a userId.");
            }
            if (!graphTo) {
              return actionError("member-info requires a target (to).");
            }
            const to = await authorizeActionTarget(graphTo);
            const currentRequesterId = isCurrentMSTeamsReadTarget({
              ctx: actionContext,
              target: to,
            })
              ? ctx.requesterSenderId
              : undefined;
            const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await getMemberInfoMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              userId,
              currentRequesterId,
            });
            return jsonMSTeamsOkActionResult("member-info", result);
          }

          if (ctx.action === "channel-list") {
            const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
            if (!teamId) {
              return actionError("channel-list requires a teamId.");
            }
            const graphTeamId = await assertMSTeamsTeamEnumerationAllowed({
              cfg: ctx.cfg,
              ctx: actionContext,
              teamId,
            });
            const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await listChannelsMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              teamId: graphTeamId,
            });
            return jsonMSTeamsOkActionResult("channel-list", result);
          }

          if (ctx.action === "channel-info") {
            const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
            const channelId = normalizeOptionalString(ctx.params.channelId) ?? "";
            if (!teamId || !channelId) {
              return actionError("channel-info requires teamId and channelId.");
            }
            const graphTarget = await authorizeActionTarget(`${teamId}/${channelId}`);
            const [graphTeamId, graphChannelId] = graphTarget.split("/", 2);
            if (!graphTeamId || !graphChannelId) {
              throw new Error("Authorized Microsoft Teams channel target is invalid.");
            }
            const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await getChannelInfoMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              teamId: graphTeamId,
              channelId: graphChannelId,
            });
            return jsonMSTeamsOkActionResult("channel-info", {
              channelInfo: result.channel,
            });
          }

          if (ctx.action === "addParticipant" || ctx.action === "removeParticipant") {
            const action = ctx.action;
            const userId = normalizeOptionalString(ctx.params.userId);
            if (!userId) {
              return actionError(`${action} requires a userId.`);
            }
            const to = resolveActionTarget(ctx.params, ctx.toolContext?.currentChannelId);
            if (!to) {
              return actionError(`${action} requires a target (to).`);
            }
            const role =
              action === "addParticipant" ? normalizeOptionalString(ctx.params.role) : undefined;
            const runtime = await loadMSTeamsChannelRuntime();
            const params = { cfg: ctx.cfg, accountId: actionAccountId, to, userId };
            const result =
              action === "addParticipant"
                ? await runtime.addParticipantMSTeams({ ...params, role })
                : await runtime.removeParticipantMSTeams(params);
            return jsonMSTeamsOkActionResult(action, result);
          }

          if (ctx.action === "renameGroup") {
            const name = typeof ctx.params.name === "string" ? ctx.params.name.trim() : "";
            if (!name) {
              return actionError("renameGroup requires a name.");
            }
            const to = resolveActionTarget(ctx.params, ctx.toolContext?.currentChannelId);
            if (!to) {
              return actionError("renameGroup requires a target (to).");
            }
            const { renameGroupMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await renameGroupMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              to,
              name,
            });
            return jsonMSTeamsOkActionResult("renameGroup", result);
          }

          // Return null to fall through to default handler
          return null as never;
        }),
      },
      status: createComputedAccountStatusAdapter<ResolvedMSTeamsAccount, ProbeMSTeamsResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        probeAccount: async ({ account }) =>
          await (
            await loadMSTeamsChannelRuntime()
          ).probeMSTeams(account.config, {
            accountId: account.accountId,
          }),
        formatCapabilitiesProbe: ({ probe }) => {
          const lines: Array<{ text: string; tone?: "error" }> = [];
          const appId = normalizeOptionalString(probe?.appId);
          if (appId) {
            lines.push({ text: `App: ${appId}` });
          }
          const graph = probe?.graph;
          if (graph) {
            const roles = Array.isArray(graph.roles) ? normalizeStringEntries(graph.roles) : [];
            const scopes = Array.isArray(graph.scopes) ? normalizeStringEntries(graph.scopes) : [];
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
            } else {
              lines.push({ text: "Graph: ok" });
            }
          }
          return lines;
        },
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            tokenStatus: account.tokenStatus,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorMSTeamsProvider } = await import("./monitor.js");
          const account = resolveMSTeamsAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
          const accountId = account.accountId;
          const webhookPath = account.config.webhook?.path || "/api/messages";
          const statusSink = createAccountStatusSink({ accountId, setStatus: ctx.setStatus });
          ctx.log?.info(
            "starting provider account " + accountId + " (Gateway route " + webhookPath + ")",
          );
          if (isMSTeamsNativeApprovalClientEnabled({ cfg: ctx.cfg, accountId })) {
            registerChannelRuntimeContext({
              channelRuntime: ctx.channelRuntime,
              channelId: "msteams",
              accountId,
              capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
              context: {},
              abortSignal: ctx.abortSignal,
            });
          }
          return monitorMSTeamsProvider({
            cfg: ctx.cfg,
            accountId,
            msteamsCfg: account.config,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink,
          });
        },
      },
    },
    security: {
      collectWarnings: ({ cfg, accountId }) => collectMSTeamsSecurityFindings({ cfg, accountId }),
    },
    pairing: {
      text: {
        idLabel: "msteamsUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
        notify: async ({ cfg, accountId, id, message }) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          await sendMessageMSTeams({
            cfg,
            accountId,
            to: id,
            text: message,
          });
        },
      },
    },
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) =>
        msteamsContextTargetsMatch(target, toolContext),
      buildToolContext: ({ context, hasRepliedRef }) => {
        const nativeChannelId = context.NativeChannelId?.trim();
        const hasChannelRoute = Boolean(nativeChannelId && nativeChannelId.includes("/"));
        const isChannel = context.ChatType === "channel";
        const messageThreadId =
          context.MessageThreadId != null
            ? normalizeOptionalString(String(context.MessageThreadId))
            : undefined;
        // Prefer MessageThreadId (root). ReplyToId fallback is channel-only — DM/group
        // quote replies must not inherit ambient thread metadata for dedupe.
        const currentThreadTs =
          messageThreadId ?? (isChannel ? normalizeOptionalString(context.ReplyToId) : undefined);
        return {
          currentChannelId: normalizeOptionalString(context.To),
          currentChatType:
            context.ChatType === "direct" ||
            context.ChatType === "group" ||
            context.ChatType === "channel"
              ? context.ChatType
              : undefined,
          currentMessagingTarget: hasChannelRoute ? nativeChannelId : undefined,
          currentGraphChannelId: hasChannelRoute ? nativeChannelId : undefined,
          currentThreadTs,
          ...(currentThreadTs ? { replyToMode: "all" as const } : {}),
          hasRepliedRef,
        };
      },
      resolveAutoThreadId: ({ cfg, accountId, to, toolContext }) =>
        resolveMSTeamsAutoThreadId({
          cfg: resolveMSTeamsAccountConfig(cfg, accountId),
          to,
          toolContext,
        }),
    },
    outbound: msteamsChannelOutbound,
  });
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
