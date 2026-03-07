import {
  buildAccountScopedDmSecurityPolicy,
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveGoogleChatGroupRequireMention,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelDock,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/googlechat";
import { GoogleChatConfigSchema } from "openclaw/plugin-sdk/googlechat";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
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
  resolveGoogleChatOutboundSpace,
} from "./targets.js";

const meta = getChatChannelMeta("googlechat");

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .replace(/^(googlechat|google-chat|gchat):/i, "")
    .replace(/^user:/i, "")
    .replace(/^users\//i, "")
    .toLowerCase();

export const googlechatDock: ChannelDock = {
  id: "googlechat",
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    media: true,
    threads: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveGoogleChatAccount({ cfg: cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off",
    buildToolContext: ({ context, hasRepliedRef }) => {
      const threadId = context.MessageThreadId ?? context.ReplyToId;
      return {
        currentChannelId: context.To?.trim() || undefined,
        currentThreadTs: threadId != null ? String(threadId) : undefined,
        hasRepliedRef,
      };
    },
  },
};

const googlechatActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => googlechatMessageActions.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

export const googlechatPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: { ...meta },
  onboarding: googlechatOnboardingAdapter,
  pairing: {
    idLabel: "googlechatUserId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveGoogleChatAccount({ cfg: cfg });
      if (account.credentialSource === "none") {
        return;
      }
      const user = normalizeGoogleChatTarget(id) ?? id;
      const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
      const space = await resolveGoogleChatOutboundSpace({ account, target });
      await sendGoogleChatMessage({
        account,
        space,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
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
    listAccountIds: (cfg) => listGoogleChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({ cfg: cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGoogleChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "googlechat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "googlechat",
        accountId,
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
      }),
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (
        resolveGoogleChatAccount({
          cfg: cfg,
          accountId,
        }).config.dm?.allowFrom ?? []
      ).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "googlechat",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dm?.policy,
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPathSuffix: "dm.",
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.googlechat !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy === "open") {
        warnings.push(
          buildOpenGroupPolicyConfigureRouteAllowlistWarning({
            surface: "Google Chat spaces",
            openScope: "any space",
            groupPolicyPath: "channels.googlechat.groupPolicy",
            routeAllowlistPath: "channels.googlechat.groups",
          }),
        );
      }
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
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
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      return listDirectoryUserEntriesFromAllowFrom({
        allowFrom: account.config.dm?.allowFrom,
        query,
        limit,
        normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
      });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      return listDirectoryGroupEntriesFromMapKeys({
        groups: account.config.groups,
        query,
        limit,
      });
    },
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
          note: "use spaces/{space} or users/{user}",
        };
      });
      return resolved;
    },
  },
  actions: googlechatActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "googlechat",
        accountId,
        name,
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
        cfg: cfg,
        channelKey: "googlechat",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "googlechat",
            })
          : namedConfig;
      const patch = input.useEnv
        ? {}
        : input.tokenFile
          ? { serviceAccountFile: input.tokenFile }
          : input.token
            ? { serviceAccount: input.token }
            : {};
      const audienceType = input.audienceType?.trim();
      const audience = input.audience?.trim();
      const webhookPath = input.webhookPath?.trim();
      const webhookUrl = input.webhookUrl?.trim();
      const configPatch = {
        ...patch,
        ...(audienceType ? { audienceType } : {}),
        ...(audience ? { audience } : {}),
        ...(webhookPath ? { webhookPath } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      };
      return applySetupAccountConfigPatch({
        cfg: next,
        channelKey: "googlechat",
        accountId,
        patch: configPatch,
      });
    },
  },
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
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      audienceType: snapshot.audienceType ?? null,
      audience: snapshot.audience ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      webhookUrl: snapshot.webhookUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeGoogleChat(account),
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
      ctx.log?.info(`[${account.accountId}] starting Google Chat webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveGoogleChatWebhookPath({ account }),
        audienceType: account.config.audienceType,
        audience: account.config.audience,
      });
      const unregister = await startGoogleChatMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      // Keep the promise pending until abort (webhook mode is passive).
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      unregister?.();
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
