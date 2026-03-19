import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import {
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  createAccountStatusSink,
  getChatChannelMeta,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  runPassiveAccountLifecycle,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "../runtime-api.js";
import { GoogleChatConfigSchema } from "../runtime-api.js";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { googlechatMessageActions } from "./actions.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSpace,
} from "./targets.js";

const meta = getChatChannelMeta("googlechat");

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .replace(/^(googlechat|google-chat|gchat):/i, "")
    .replace(/^user:/i, "")
    .replace(/^users\//i, "")
    .toLowerCase();

const googleChatConfigAdapter = createScopedChannelConfigAdapter<ResolvedGoogleChatAccount>({
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
    "name",
  ],
  resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatAllowFromEntry,
    }),
  resolveDefaultTo: (account: ResolvedGoogleChatAccount) => account.config.defaultTo,
});

const resolveGoogleChatDmPolicy = createScopedDmSecurityResolver<ResolvedGoogleChatAccount>({
  channelKey: "googlechat",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => formatAllowFromEntry(raw),
});

const googlechatActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) => googlechatMessageActions.describeMessageTool?.(ctx) ?? null,
  extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

const collectGoogleChatGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedGoogleChatAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.googlechat !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Google Chat spaces",
      openBehavior: "allows any space to trigger (mention-gated)",
      remediation:
        'Set channels.googlechat.groupPolicy="allowlist" and configure channels.googlechat.groups',
    },
  });

const collectGoogleChatSecurityWarnings = composeWarningCollectors<{
  cfg: OpenClawConfig;
  account: ResolvedGoogleChatAccount;
}>(
  collectGoogleChatGroupPolicyWarnings,
  createConditionalWarningCollector(
    ({ account }) =>
      account.config.dm?.policy === "open" &&
      '- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".',
  ),
);

export const googlechatPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: { ...meta },
  setup: googlechatSetupAdapter,
  setupWizard: googlechatSetupWizard,
  pairing: createTextPairingAdapter({
    idLabel: "googlechatUserId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notify: async ({ cfg, id, message }) => {
      const account = resolveGoogleChatAccount({ cfg: cfg });
      if (account.credentialSource === "none") {
        return;
      }
      const user = normalizeGoogleChatTarget(id) ?? id;
      const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
      const space = await resolveGoogleChatOutboundSpace({ account, target });
      const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
      await sendGoogleChatMessage({
        account,
        space,
        text: message,
      });
    },
  }),
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
  config: {
    ...googleChatConfigAdapter,
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
  },
  security: {
    resolveDmPolicy: resolveGoogleChatDmPolicy,
    collectWarnings: collectGoogleChatSecurityWarnings,
  },
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: normalizeGoogleChatTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
      },
      hint: "<spaces/{space}|users/{user}>",
    },
  },
  directory: createChannelDirectoryAdapter({
    listPeers: async (params) =>
      listResolvedDirectoryUserEntriesFromAllowFrom({
        ...params,
        resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({ cfg, accountId }),
        resolveAllowFrom: (account) => account.config.dm?.allowFrom,
        normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
      }),
    listGroups: async (params) =>
      listResolvedDirectoryGroupEntriesFromMapKeys({
        ...params,
        resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({ cfg, accountId }),
        resolveGroups: (account) => account.config.groups,
      }),
  }),
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
          note: "use spaces/{space} or users/{user}",
        };
      });
      return resolved;
    },
  },
  actions: googlechatActions,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getGoogleChatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";

      if (trimmed) {
        const normalized = normalizeGoogleChatTarget(trimmed);
        if (!normalized) {
          return {
            ok: false,
            error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
          };
        }
        return { ok: true, to: normalized };
      }

      return {
        ok: false,
        error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = (threadId ?? replyToId ?? undefined) as string | undefined;
      const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space,
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
      threadId,
    }) => {
      if (!mediaUrl) {
        throw new Error("Google Chat mediaUrl is required.");
      }
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = (threadId ?? replyToId ?? undefined) as string | undefined;
      const runtime = getGoogleChatRuntime();
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          (
            cfg.channels?.["googlechat"] as
              | { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number }
              | undefined
          )?.accounts?.[accountId]?.mediaMaxMb ??
          (cfg.channels?.["googlechat"] as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
        accountId,
      });
      const effectiveMaxBytes = maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const loaded = /^https?:\/\//i.test(mediaUrl)
        ? await runtime.channel.media.fetchRemoteMedia({
            url: mediaUrl,
            maxBytes: effectiveMaxBytes,
          })
        : await runtime.media.loadWebMedia(mediaUrl, {
            maxBytes: effectiveMaxBytes,
            localRoots: mediaLocalRoots?.length ? mediaLocalRoots : undefined,
          });
      const { sendGoogleChatMessage, uploadGoogleChatAttachment } =
        await loadGoogleChatChannelRuntime();
      const upload = await uploadGoogleChatAttachment({
        account,
        space,
        filename: loaded.fileName ?? "attachment",
        buffer: loaded.buffer,
        contentType: loaded.contentType,
      });
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
        attachments: upload.attachmentUploadToken
          ? [{ attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName }]
          : undefined,
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space,
      };
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
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!entry.audience) {
          issues.push({
            channel: "googlechat",
            accountId,
            kind: "config",
            message: "Google Chat audience is missing (set channels.googlechat.audience).",
            fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
          });
        }
        if (!entry.audienceType) {
          issues.push({
            channel: "googlechat",
            accountId,
            kind: "config",
            message: "Google Chat audienceType is missing (app-url or project-number).",
            fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveProbedChannelStatusSummary(snapshot, {
        credentialSource: snapshot.credentialSource ?? "none",
        audienceType: snapshot.audienceType ?? null,
        audience: snapshot.audience ?? null,
        webhookPath: snapshot.webhookPath ?? null,
        webhookUrl: snapshot.webhookUrl ?? null,
      }),
    probeAccount: async ({ account }) =>
      (await loadGoogleChatChannelRuntime()).probeGoogleChat(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        runtime,
        probe,
      });
      return {
        ...base,
        credentialSource: account.credentialSource,
        audienceType: account.config.audienceType,
        audience: account.config.audience,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        dmPolicy: account.config.dm?.policy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const statusSink = createAccountStatusSink({
        accountId: account.accountId,
        setStatus: ctx.setStatus,
      });
      ctx.log?.info(`[${account.accountId}] starting Google Chat webhook`);
      const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } =
        await loadGoogleChatChannelRuntime();
      statusSink({
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveGoogleChatWebhookPath({ account }),
        audienceType: account.config.audienceType,
        audience: account.config.audience,
      });
      await runPassiveAccountLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () =>
          await startGoogleChatMonitor({
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            webhookPath: account.config.webhookPath,
            webhookUrl: account.config.webhookUrl,
            statusSink,
          }),
        stop: async (unregister) => {
          unregister?.();
        },
        onStop: async () => {
          statusSink({
            running: false,
            lastStopAt: Date.now(),
          });
        },
      });
    },
  },
};
