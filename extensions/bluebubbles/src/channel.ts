import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/bluebubbles";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  collectBlueBubblesStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/bluebubbles";
import {
  buildAccountScopedDmSecurityPolicy,
  collectOpenGroupPolicyRestrictSendersWarnings,
  createAccountStatusSink,
  formatNormalizedAllowFromEntries,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/compat";
import {
  listBlueBubblesAccountIds,
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { bluebubblesMessageActions } from "./actions.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { monitorBlueBubblesProvider, resolveWebhookPathFromConfig } from "./monitor.js";
import { blueBubblesOnboardingAdapter } from "./onboarding.js";
import { probeBlueBubbles, type BlueBubblesProbe } from "./probe.js";
import { sendMessageBlueBubbles } from "./send.js";
import {
  extractHandleFromChatGuid,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget,
} from "./targets.js";

const meta = {
  id: "bluebubbles",
  label: "BlueBubbles",
  selectionLabel: "BlueBubbles (macOS app)",
  detailLabel: "BlueBubbles",
  docsPath: "/channels/bluebubbles",
  docsLabel: "bluebubbles",
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  systemImage: "bubble.left.and.text.bubble.right",
  aliases: ["bb"],
  order: 75,
  preferOver: ["imessage"],
};

export const bluebubblesPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  id: "bluebubbles",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    effects: true,
    groupManagement: true,
  },
  groups: {
    resolveRequireMention: resolveBlueBubblesGroupRequireMention,
    resolveToolPolicy: resolveBlueBubblesGroupToolPolicy,
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
      hasRepliedRef,
    }),
  },
  reload: { configPrefixes: ["channels.bluebubbles"] },
  configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
  onboarding: blueBubblesOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listBlueBubblesAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({ cfg: cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "bluebubbles",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "bluebubbles",
        accountId,
        clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      mapAllowFromEntries(resolveBlueBubblesAccount({ cfg: cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
      }),
  },
  actions: bluebubblesMessageActions,
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "bluebubbles",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, "")),
      });
    },
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "allowlist";
      return collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy,
        surface: "BlueBubbles groups",
        openScope: "any member",
        groupPolicyPath: "channels.bluebubbles.groupPolicy",
        groupAllowFromPath: "channels.bluebubbles.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  messaging: {
    normalizeTarget: normalizeBlueBubblesMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeBlueBubblesTargetId,
      hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>",
    },
    formatTargetDisplay: ({ target, display }) => {
      const shouldParseDisplay = (value: string): boolean => {
        if (looksLikeBlueBubblesTargetId(value)) {
          return true;
        }
        return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
      };

      // Helper to extract a clean handle from any BlueBubbles target format
      const extractCleanDisplay = (value: string | undefined): string | null => {
        const trimmed = value?.trim();
        if (!trimmed) {
          return null;
        }
        try {
          const parsed = parseBlueBubblesTarget(trimmed);
          if (parsed.kind === "chat_guid") {
            const handle = extractHandleFromChatGuid(parsed.chatGuid);
            if (handle) {
              return handle;
            }
          }
          if (parsed.kind === "handle") {
            return normalizeBlueBubblesHandle(parsed.to);
          }
        } catch {
          // Fall through
        }
        // Strip common prefixes and try raw extraction
        const stripped = trimmed
          .replace(/^bluebubbles:/i, "")
          .replace(/^chat_guid:/i, "")
          .replace(/^chat_id:/i, "")
          .replace(/^chat_identifier:/i, "");
        const handle = extractHandleFromChatGuid(stripped);
        if (handle) {
          return handle;
        }
        // Don't return raw chat_guid formats - they contain internal routing info
        if (stripped.includes(";-;") || stripped.includes(";+;")) {
          return null;
        }
        return stripped;
      };

      // Try to get a clean display from the display parameter first
      const trimmedDisplay = display?.trim();
      if (trimmedDisplay) {
        if (!shouldParseDisplay(trimmedDisplay)) {
          return trimmedDisplay;
        }
        const cleanDisplay = extractCleanDisplay(trimmedDisplay);
        if (cleanDisplay) {
          return cleanDisplay;
        }
      }

      // Fall back to extracting from target
      const cleanTarget = extractCleanDisplay(target);
      if (cleanTarget) {
        return cleanTarget;
      }

      // Last resort: return display or target as-is
      return display?.trim() || target?.trim() || "";
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "bluebubbles",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.httpUrl && !input.password) {
        return "BlueBubbles requires --http-url and --password.";
      }
      if (!input.httpUrl) {
        return "BlueBubbles requires --http-url.";
      }
      if (!input.password) {
        return "BlueBubbles requires --password.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "bluebubbles",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "bluebubbles",
            })
          : namedConfig;
      return applyBlueBubblesConnectionConfig({
        cfg: next,
        accountId,
        patch: {
          serverUrl: input.httpUrl,
          password: input.password,
          webhookPath: input.webhookPath,
        },
        onlyDefinedFields: true,
      });
    },
  },
  pairing: {
    idLabel: "bluebubblesSenderId",
    normalizeAllowEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageBlueBubbles(id, PAIRING_APPROVED_MESSAGE, {
        cfg: cfg,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const rawReplyToId = typeof replyToId === "string" ? replyToId.trim() : "";
      // Resolve short ID (e.g., "5") to full UUID
      const replyToMessageGuid = rawReplyToId
        ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true })
        : "";
      const result = await sendMessageBlueBubbles(to, text, {
        cfg: cfg,
        accountId: accountId ?? undefined,
        replyToMessageGuid: replyToMessageGuid || undefined,
      });
      return { channel: "bluebubbles", ...result };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId } = ctx;
      const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx as {
        mediaPath?: string;
        mediaBuffer?: Uint8Array;
        contentType?: string;
        filename?: string;
        caption?: string;
      };
      const resolvedCaption = caption ?? text;
      const result = await sendBlueBubblesMedia({
        cfg: cfg,
        to,
        mediaUrl,
        mediaPath,
        mediaBuffer,
        contentType,
        filename,
        caption: resolvedCaption ?? undefined,
        replyToId: replyToId ?? null,
        accountId: accountId ?? undefined,
      });

      return { channel: "bluebubbles", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectBlueBubblesStatusIssues,
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeBlueBubbles({
        baseUrl: account.baseUrl,
        password: account.config.password ?? null,
        timeoutMs,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = (probe as BlueBubblesProbe | undefined)?.ok;
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        runtime,
        probe,
      });
      return {
        ...base,
        baseUrl: account.baseUrl,
        connected: probeOk ?? running,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const webhookPath = resolveWebhookPathFromConfig(account.config);
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
      statusSink({
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
      return monitorBlueBubblesProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
        webhookPath,
      });
    },
  },
};
