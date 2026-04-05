import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  composeAccountWarningCollectors,
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { googlechatMessageActions } from "./actions.js";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  buildChannelConfigSchema,
  chunkTextForOutbound,
  createAccountStatusSink,
  DEFAULT_ACCOUNT_ID,
  fetchRemoteMedia,
  getChatChannelMeta,
  GoogleChatConfigSchema,
  listGoogleChatAccountIds,
  loadOutboundMediaFromUrl,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
  resolveGoogleChatOutboundSpace,
  runPassiveAccountLifecycle,
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  type ChannelMessageActionAdapter,
  type ChannelStatusIssue,
  type OpenClawConfig,
  type ResolvedGoogleChatAccount,
} from "./channel.deps.runtime.js";
import { collectGoogleChatMutableAllowlistWarnings } from "./doctor.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

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
  resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
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

const collectGoogleChatSecurityWarnings = composeAccountWarningCollectors<
  ResolvedGoogleChatAccount,
  {
    cfg: OpenClawConfig;
    account: ResolvedGoogleChatAccount;
  }
>(
  collectGoogleChatGroupPolicyWarnings,
  (account) =>
    account.config.dm?.policy === "open" &&
    '- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".',
);

export const googlechatPlugin = createChatChannelPlugin({
  base: {
    id: "googlechat",
    meta: { ...meta },
    setup: googlechatSetupAdapter,
    setupWizard: googlechatSetupWizard,
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
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.credentialSource !== "none",
          extra: {
            credentialSource: account.credentialSource,
          },
        }),
    },
    auth: googleChatApprovalAuth,
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    groups: {
      resolveRequireMention: resolveGoogleChatGroupRequireMention,
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
        listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedGoogleChatAccount>({
          ...params,
          resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
          resolveAllowFrom: (account) => account.config.dm?.allowFrom,
          normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
        }),
      listGroups: async (params) =>
        listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedGoogleChatAccount>({
          ...params,
          resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
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
    doctor: {
      dmAllowFromMode: "nestedOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
      collectMutableAllowlistWarnings: collectGoogleChatMutableAllowlistWarnings,
    },
    status: createComputedAccountStatusAdapter<ResolvedGoogleChatAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
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
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        extra: {
          credentialSource: account.credentialSource,
          audienceType: account.config.audienceType,
          audience: account.config.audience,
          webhookPath: account.config.webhookPath,
          webhookUrl: account.config.webhookUrl,
          dmPolicy: account.config.dm?.policy ?? "pairing",
        },
      }),
    }),
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
  },
  pairing: {
    text: {
      idLabel: "googlechatUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveGoogleChatAccount({ cfg: cfg, accountId });
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
    },
  },
  security: {
    dm: {
      channelKey: "googlechat",
      resolvePolicy: (account) => account.config.dm?.policy,
      resolveAllowFrom: (account) => account.config.dm?.allowFrom,
      allowFromPathSuffix: "dm.",
      normalizeEntry: (raw) => formatAllowFromEntry(raw),
    },
    collectWarnings: collectGoogleChatSecurityWarnings,
  },
  threading: {
    scopedAccountReplyToMode: {
      resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({ cfg, accountId }),
      resolveReplyToMode: (account) => account.config.replyToMode,
      fallback: "off",
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      sanitizeText: ({ text }) => sanitizeForPlainText(text),
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
    },
    attachedResults: {
      channel: "googlechat",
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
          messageId: result?.messageName ?? "",
          chatId: space,
        };
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
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
          ? await fetchRemoteMedia({
              url: mediaUrl,
              maxBytes: effectiveMaxBytes,
            })
          : await loadOutboundMediaFromUrl(mediaUrl, {
              maxBytes: effectiveMaxBytes,
              mediaAccess,
              mediaLocalRoots,
              mediaReadFile,
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
            ? [
                {
                  attachmentUploadToken: upload.attachmentUploadToken,
                  contentName: loaded.fileName,
                },
              ]
            : undefined,
        });
        return {
          messageId: result?.messageName ?? "",
          chatId: space,
        };
      },
    },
  },
});
