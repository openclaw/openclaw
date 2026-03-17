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
  setAccountEnabledInConfigSection
} from "openclaw/plugin-sdk/bluebubbles";
import {
  buildAccountScopedDmSecurityPolicy,
  collectOpenGroupPolicyRestrictSendersWarnings,
  createAccountStatusSink,
  formatNormalizedAllowFromEntries,
  mapAllowFromEntries
} from "openclaw/plugin-sdk/compat";
import {
  listBlueBubblesAccountIds,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId
} from "./accounts.js";
import { bluebubblesMessageActions } from "./actions.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { monitorBlueBubblesProvider, resolveWebhookPathFromConfig } from "./monitor.js";
import { blueBubblesOnboardingAdapter } from "./onboarding.js";
import { probeBlueBubbles } from "./probe.js";
import { sendMessageBlueBubbles } from "./send.js";
import {
  extractHandleFromChatGuid,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget
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
  preferOver: ["imessage"]
};
const bluebubblesPlugin = {
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
    groupManagement: true
  },
  groups: {
    resolveRequireMention: resolveBlueBubblesGroupRequireMention,
    resolveToolPolicy: resolveBlueBubblesGroupToolPolicy
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || void 0,
      currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
      hasRepliedRef
    })
  },
  reload: { configPrefixes: ["channels.bluebubbles"] },
  configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
  onboarding: blueBubblesOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listBlueBubblesAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
      cfg,
      sectionKey: "bluebubbles",
      accountId,
      enabled,
      allowTopLevel: true
    }),
    deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
      cfg,
      sectionKey: "bluebubbles",
      accountId,
      clearBaseFields: ["serverUrl", "password", "name", "webhookPath"]
    }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl
    }),
    resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveBlueBubblesAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) => formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, ""))
    })
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
        normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, ""))
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
        mentionGated: false
      });
    }
  },
  messaging: {
    normalizeTarget: normalizeBlueBubblesMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeBlueBubblesTargetId,
      hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>"
    },
    formatTargetDisplay: ({ target, display }) => {
      const shouldParseDisplay = (value) => {
        if (looksLikeBlueBubblesTargetId(value)) {
          return true;
        }
        return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
      };
      const extractCleanDisplay = (value) => {
        const trimmed = value?.trim();
        if (!trimmed) {
          return null;
        }
        try {
          const parsed = parseBlueBubblesTarget(trimmed);
          if (parsed.kind === "chat_guid") {
            const handle2 = extractHandleFromChatGuid(parsed.chatGuid);
            if (handle2) {
              return handle2;
            }
          }
          if (parsed.kind === "handle") {
            return normalizeBlueBubblesHandle(parsed.to);
          }
        } catch {
        }
        const stripped = trimmed.replace(/^bluebubbles:/i, "").replace(/^chat_guid:/i, "").replace(/^chat_id:/i, "").replace(/^chat_identifier:/i, "");
        const handle = extractHandleFromChatGuid(stripped);
        if (handle) {
          return handle;
        }
        if (stripped.includes(";-;") || stripped.includes(";+;")) {
          return null;
        }
        return stripped;
      };
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
      const cleanTarget = extractCleanDisplay(target);
      if (cleanTarget) {
        return cleanTarget;
      }
      return display?.trim() || target?.trim() || "";
    }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
      cfg,
      channelKey: "bluebubbles",
      accountId,
      name
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
        cfg,
        channelKey: "bluebubbles",
        accountId,
        name: input.name
      });
      const next = accountId !== DEFAULT_ACCOUNT_ID ? migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        channelKey: "bluebubbles"
      }) : namedConfig;
      return applyBlueBubblesConnectionConfig({
        cfg: next,
        accountId,
        patch: {
          serverUrl: input.httpUrl,
          password: input.password,
          webhookPath: input.webhookPath
        },
        onlyDefinedFields: true
      });
    }
  },
  pairing: {
    idLabel: "bluebubblesSenderId",
    normalizeAllowEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageBlueBubbles(id, PAIRING_APPROVED_MESSAGE, {
        cfg
      });
    }
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4e3,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>")
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const rawReplyToId = typeof replyToId === "string" ? replyToId.trim() : "";
      const replyToMessageGuid = rawReplyToId ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true }) : "";
      const result = await sendMessageBlueBubbles(to, text, {
        cfg,
        accountId: accountId ?? void 0,
        replyToMessageGuid: replyToMessageGuid || void 0
      });
      return { channel: "bluebubbles", ...result };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId } = ctx;
      const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx;
      const resolvedCaption = caption ?? text;
      const result = await sendBlueBubblesMedia({
        cfg,
        to,
        mediaUrl,
        mediaPath,
        mediaBuffer,
        contentType,
        filename,
        caption: resolvedCaption ?? void 0,
        replyToId: replyToId ?? null,
        accountId: accountId ?? void 0
      });
      return { channel: "bluebubbles", ...result };
    }
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null
    },
    collectStatusIssues: collectBlueBubblesStatusIssues,
    buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
    probeAccount: async ({ account, timeoutMs }) => probeBlueBubbles({
      baseUrl: account.baseUrl,
      password: account.config.password ?? null,
      timeoutMs
    }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = probe?.ok;
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        runtime,
        probe
      });
      return {
        ...base,
        baseUrl: account.baseUrl,
        connected: probeOk ?? running
      };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const webhookPath = resolveWebhookPathFromConfig(account.config);
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus
      });
      statusSink({
        baseUrl: account.baseUrl
      });
      ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
      return monitorBlueBubblesProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
        webhookPath
      });
    }
  }
};
export {
  bluebubblesPlugin
};
