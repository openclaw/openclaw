import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  collectAllowlistProviderGroupPolicyWarnings,
  createScopedAccountConfigAccessors,
  createScopedDmSecurityResolver,
  formatNormalizedAllowFromEntries
} from "openclaw/plugin-sdk/compat";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  createAccountStatusSink,
  getChatChannelMeta,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveGoogleChatGroupRequireMention,
  runPassiveAccountLifecycle
} from "openclaw/plugin-sdk/googlechat";
import { GoogleChatConfigSchema } from "openclaw/plugin-sdk/googlechat";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount
} from "./accounts.js";
import { googlechatMessageActions } from "./actions.js";
import { sendGoogleChatMessage, uploadGoogleChatAttachment, probeGoogleChat } from "./api.js";
import { resolveGoogleChatWebhookPath, startGoogleChatMonitor } from "./monitor.js";
import { googlechatOnboardingAdapter } from "./onboarding.js";
import { getGoogleChatRuntime } from "./runtime.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSpace
} from "./targets.js";
const meta = getChatChannelMeta("googlechat");
const formatAllowFromEntry = (entry) => entry.trim().replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:/i, "").replace(/^users\//i, "").toLowerCase();
const googleChatConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveGoogleChatAccount({ cfg, accountId }),
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
    allowFrom,
    normalizeEntry: formatAllowFromEntry
  }),
  resolveDefaultTo: (account) => account.config.defaultTo
});
const googleChatConfigBase = createScopedChannelConfigBase({
  sectionKey: "googlechat",
  listAccountIds: listGoogleChatAccountIds,
  resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  clearBaseFields: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "botUser",
    "name"
  ]
});
const resolveGoogleChatDmPolicy = createScopedDmSecurityResolver({
  channelKey: "googlechat",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => formatAllowFromEntry(raw)
});
const googlechatDock = {
  id: "googlechat",
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    media: true,
    threads: true,
    blockStreaming: true
  },
  outbound: { textChunkLimit: 4e3 },
  config: googleChatConfigAccessors,
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off",
    buildToolContext: ({ context, hasRepliedRef }) => {
      const threadId = context.MessageThreadId ?? context.ReplyToId;
      return {
        currentChannelId: context.To?.trim() || void 0,
        currentThreadTs: threadId != null ? String(threadId) : void 0,
        hasRepliedRef
      };
    }
  }
};
const googlechatActions = {
  listActions: (ctx) => googlechatMessageActions.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  }
};
const googlechatPlugin = {
  id: "googlechat",
  meta: { ...meta },
  onboarding: googlechatOnboardingAdapter,
  pairing: {
    idLabel: "googlechatUserId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveGoogleChatAccount({ cfg });
      if (account.credentialSource === "none") {
        return;
      }
      const user = normalizeGoogleChatTarget(id) ?? id;
      const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
      const space = await resolveGoogleChatOutboundSpace({ account, target });
      await sendGoogleChatMessage({
        account,
        space,
        text: PAIRING_APPROVED_MESSAGE
      });
    }
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: true
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1e3 }
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
  config: {
    ...googleChatConfigBase,
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource
    }),
    ...googleChatConfigAccessors
  },
  security: {
    resolveDmPolicy: resolveGoogleChatDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      const warnings = collectAllowlistProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.googlechat !== void 0,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) => groupPolicy === "open" ? [
          buildOpenGroupPolicyConfigureRouteAllowlistWarning({
            surface: "Google Chat spaces",
            openScope: "any space",
            groupPolicyPath: "channels.googlechat.groupPolicy",
            routeAllowlistPath: "channels.googlechat.groups"
          })
        ] : []
      });
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".`
        );
      }
      return warnings;
    }
  },
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off"
  },
  messaging: {
    normalizeTarget: normalizeGoogleChatTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
      },
      hint: "<spaces/{space}|users/{user}>"
    }
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg,
        accountId
      });
      return listDirectoryUserEntriesFromAllowFrom({
        allowFrom: account.config.dm?.allowFrom,
        query,
        limit,
        normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry
      });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg,
        accountId
      });
      return listDirectoryGroupEntriesFromMapKeys({
        groups: account.config.groups,
        query,
        limit
      });
    }
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const normalized = normalizeGoogleChatTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (kind === "user" && isGoogleChatUserTarget(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        return {
          input,
          resolved: false,
          note: "use spaces/{space} or users/{user}"
        };
      });
      return resolved;
    }
  },
  actions: googlechatActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
      cfg,
      channelKey: "googlechat",
      accountId,
      name
    }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Google Chat requires --token (service account JSON) or --token-file.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "googlechat",
        accountId,
        name: input.name
      });
      const next = accountId !== DEFAULT_ACCOUNT_ID ? migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        channelKey: "googlechat"
      }) : namedConfig;
      const patch = input.useEnv ? {} : input.tokenFile ? { serviceAccountFile: input.tokenFile } : input.token ? { serviceAccount: input.token } : {};
      const audienceType = input.audienceType?.trim();
      const audience = input.audience?.trim();
      const webhookPath = input.webhookPath?.trim();
      const webhookUrl = input.webhookUrl?.trim();
      const configPatch = {
        ...patch,
        ...audienceType ? { audienceType } : {},
        ...audience ? { audience } : {},
        ...webhookPath ? { webhookPath } : {},
        ...webhookUrl ? { webhookUrl } : {}
      };
      return applySetupAccountConfigPatch({
        cfg: next,
        channelKey: "googlechat",
        accountId,
        patch: configPatch
      });
    }
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getGoogleChatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4e3,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        const normalized = normalizeGoogleChatTarget(trimmed);
        if (!normalized) {
          return {
            ok: false,
            error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
          };
        }
        return { ok: true, to: normalized };
      }
      return {
        ok: false,
        error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveGoogleChatAccount({
        cfg,
        accountId
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = threadId ?? replyToId ?? void 0;
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space
      };
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      replyToId,
      threadId
    }) => {
      if (!mediaUrl) {
        throw new Error("Google Chat mediaUrl is required.");
      }
      const account = resolveGoogleChatAccount({
        cfg,
        accountId
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = threadId ?? replyToId ?? void 0;
      const runtime = getGoogleChatRuntime();
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg: cfg2, accountId: accountId2 }) => cfg2.channels?.["googlechat"]?.accounts?.[accountId2]?.mediaMaxMb ?? cfg2.channels?.["googlechat"]?.mediaMaxMb,
        accountId
      });
      const effectiveMaxBytes = maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const loaded = /^https?:\/\//i.test(mediaUrl) ? await runtime.channel.media.fetchRemoteMedia({
        url: mediaUrl,
        maxBytes: effectiveMaxBytes
      }) : await runtime.media.loadWebMedia(mediaUrl, {
        maxBytes: effectiveMaxBytes,
        localRoots: mediaLocalRoots?.length ? mediaLocalRoots : void 0
      });
      const upload = await uploadGoogleChatAttachment({
        account,
        space,
        filename: loaded.fileName ?? "attachment",
        buffer: loaded.buffer,
        contentType: loaded.contentType
      });
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
        attachments: upload.attachmentUploadToken ? [{ attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName }] : void 0
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space
      };
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
    collectStatusIssues: (accounts) => accounts.flatMap((entry) => {
      const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
      const enabled = entry.enabled !== false;
      const configured = entry.configured === true;
      if (!enabled || !configured) {
        return [];
      }
      const issues = [];
      if (!entry.audience) {
        issues.push({
          channel: "googlechat",
          accountId,
          kind: "config",
          message: "Google Chat audience is missing (set channels.googlechat.audience).",
          fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
        });
      }
      if (!entry.audienceType) {
        issues.push({
          channel: "googlechat",
          accountId,
          kind: "config",
          message: "Google Chat audienceType is missing (app-url or project-number).",
          fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
        });
      }
      return issues;
    }),
    buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
      credentialSource: snapshot.credentialSource ?? "none",
      audienceType: snapshot.audienceType ?? null,
      audience: snapshot.audience ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      webhookUrl: snapshot.webhookUrl ?? null
    }),
    probeAccount: async ({ account }) => probeGoogleChat(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        runtime,
        probe
      });
      return {
        ...base,
        credentialSource: account.credentialSource,
        audienceType: account.config.audienceType,
        audience: account.config.audience,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        dmPolicy: account.config.dm?.policy ?? "pairing"
      };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const statusSink = createAccountStatusSink({
        accountId: account.accountId,
        setStatus: ctx.setStatus
      });
      ctx.log?.info(`[${account.accountId}] starting Google Chat webhook`);
      statusSink({
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveGoogleChatWebhookPath({ account }),
        audienceType: account.config.audienceType,
        audience: account.config.audience
      });
      await runPassiveAccountLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () => await startGoogleChatMonitor({
          account,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          webhookPath: account.config.webhookPath,
          webhookUrl: account.config.webhookUrl,
          statusSink
        }),
        stop: async (unregister) => {
          unregister?.();
        },
        onStop: async () => {
          statusSink({
            running: false,
            lastStopAt: Date.now()
          });
        }
      });
    }
  }
};
export {
  googlechatDock,
  googlechatPlugin
};
