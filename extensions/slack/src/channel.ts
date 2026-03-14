import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  buildAccountScopedDmSecurityPolicy,
  collectOpenProviderGroupPolicyWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  applyAccountNameToChannelSection,
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  extractSlackToolSend,
  getChatChannelMeta,
  handleSlackMessageAction,
  inspectSlackAccount,
  listSlackMessageActions,
  listSlackAccountIds,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  looksLikeSlackTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeSlackMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode,
  isSlackInteractiveRepliesEnabled,
  resolveSlackGroupRequireMention,
  resolveSlackGroupToolPolicy,
  buildSlackThreadingToolContext,
  slackOnboardingAdapter,
  SlackConfigSchema,
  type ChannelPlugin,
  type ResolvedSlackAccount,
} from "openclaw/plugin-sdk/slack";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { getSlackRuntime } from "./runtime.js";

const meta = getChatChannelMeta("slack");

// Select the appropriate Slack token for read/write operations.
function getTokenForOperation(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  const userToken = account.config.userToken?.trim() || undefined;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;
  if (operation === "read") {
    return userToken ?? botToken;
  }
  if (!allowUserWrites) {
    return botToken;
  }
  return botToken ?? userToken;
}

function isSlackAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

type SlackSendFn = ReturnType<typeof getSlackRuntime>["channel"]["slack"]["sendMessageSlack"];

function resolveSlackSendContext(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string;
  deps?: { sendSlack?: SlackSendFn };
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  const send = params.deps?.sendSlack ?? getSlackRuntime().channel.slack.sendMessageSlack;
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = getTokenForOperation(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = params.replyToId ?? params.threadId;
  return { send, threadTsValue, tokenOverride };
}

const slackConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

const slackConfigBase = createScopedChannelConfigBase({
  sectionKey: "slack",
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
});

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  id: "slack",
  meta: {
    ...meta,
    preferSessionLookupForAnnounceTarget: true,
  },
  onboarding: slackOnboardingAdapter,
  pairing: {
    idLabel: "slackUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(slack|user):/i, ""),
    notifyApproval: async ({ id }) => {
      const cfg = getSlackRuntime().config.loadConfig();
      const account = resolveSlackAccount({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const token = getTokenForOperation(account, "write");
      const botToken = account.botToken?.trim();
      const tokenOverride = token && token !== botToken ? token : undefined;
      if (tokenOverride) {
        await getSlackRuntime().channel.slack.sendMessageSlack(
          `user:${id}`,
          PAIRING_APPROVED_MESSAGE,
          {
            token: tokenOverride,
          },
        );
      } else {
        await getSlackRuntime().channel.slack.sendMessageSlack(
          `user:${id}`,
          PAIRING_APPROVED_MESSAGE,
        );
      }
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId })
        ? [
            "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
            "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
          ]
        : [
            "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
          ],
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.slack"] },
  configSchema: buildChannelConfigSchema(SlackConfigSchema),
  config: {
    ...slackConfigBase,
    isConfigured: (account) => isSlackAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isSlackAccountConfigured(account),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    }),
    ...slackConfigAccessors,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "slack",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.dm?.policy,
        allowFrom: account.dm?.allowFrom ?? [],
        allowFromPathSuffix: "dm.",
        normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, ""),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const channelAllowlistConfigured =
        Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0;

      return collectOpenProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.slack !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyConfiguredRouteWarnings({
            groupPolicy,
            routeAllowlistConfigured: channelAllowlistConfigured,
            configureRouteAllowlist: {
              surface: "Slack channels",
              openScope: "any channel not explicitly denied",
              groupPolicyPath: "channels.slack.groupPolicy",
              routeAllowlistPath: "channels.slack.channels",
            },
            missingRouteAllowlist: {
              surface: "Slack channels",
              openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
              remediation:
                'Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels',
            },
          }),
      });
    },
  },
  groups: {
    resolveRequireMention: resolveSlackGroupRequireMention,
    resolveToolPolicy: resolveSlackGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId, chatType }) =>
      resolveSlackReplyToMode(resolveSlackAccount({ cfg, accountId }), chatType),
    allowExplicitReplyTagsWhenOff: false,
    buildToolContext: (params) => buildSlackThreadingToolContext(params),
  },
  messaging: {
    normalizeTarget: normalizeSlackMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSlackTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listSlackDirectoryPeersFromConfig(params),
    listGroups: async (params) => listSlackDirectoryGroupsFromConfig(params),
    listPeersLive: async (params) => getSlackRuntime().channel.slack.listDirectoryPeersLive(params),
    listGroupsLive: async (params) =>
      getSlackRuntime().channel.slack.listDirectoryGroupsLive(params),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const toResolvedTarget = <
        T extends { input: string; resolved: boolean; id?: string; name?: string },
      >(
        entry: T,
        note?: string,
      ) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id,
        name: entry.name,
        note,
      });
      const account = resolveSlackAccount({ cfg, accountId });
      const token = account.config.userToken?.trim() || account.botToken?.trim();
      if (!token) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "missing Slack token",
        }));
      }
      if (kind === "group") {
        const resolved = await getSlackRuntime().channel.slack.resolveChannelAllowlist({
          token,
          entries: inputs,
        });
        return resolved.map((entry) =>
          toResolvedTarget(entry, entry.archived ? "archived" : undefined),
        );
      }
      const resolved = await getSlackRuntime().channel.slack.resolveUserAllowlist({
        token,
        entries: inputs,
      });
      return resolved.map((entry) => toResolvedTarget(entry, entry.note));
    },
  },
  actions: {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) =>
      await handleSlackMessageAction({
        providerId: meta.id,
        ctx,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await getSlackRuntime().channel.slack.handleSlackAction(action, cfg, toolContext),
      }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "slack",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Slack env tokens can only be used for the default account.";
      }
      if (!input.useEnv && (!input.botToken || !input.appToken)) {
        return "Slack requires --bot-token and --app-token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "slack",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "slack",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            slack: {
              ...next.channels?.slack,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(input.botToken ? { botToken: input.botToken } : {}),
                    ...(input.appToken ? { appToken: input.appToken } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          slack: {
            ...next.channels?.slack,
            enabled: true,
            accounts: {
              ...next.channels?.slack?.accounts,
              [accountId]: {
                ...next.channels?.slack?.accounts?.[accountId],
                enabled: true,
                ...(input.botToken ? { botToken: input.botToken } : {}),
                ...(input.appToken ? { appToken: input.appToken } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
      const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
        cfg,
        accountId: accountId ?? undefined,
        deps,
        replyToId,
        threadId,
      });
      const result = await send(to, text, {
        cfg,
        threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
    },
    sendMedia: async ({
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      cfg,
    }) => {
      const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
        cfg,
        accountId: accountId ?? undefined,
        deps,
        replyToId,
        threadId,
      });
      const result = await send(to, text, {
        cfg,
        mediaUrl,
        mediaLocalRoots,
        threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
        accountId: accountId ?? undefined,
        ...(tokenOverride ? { token: tokenOverride } : {}),
      });
      return { channel: "slack", ...result };
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
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveProbedChannelStatusSummary(snapshot, {
        botTokenSource: snapshot.botTokenSource ?? "none",
        appTokenSource: snapshot.appTokenSource ?? "none",
      }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      if (!token) {
        return { ok: false, error: "missing token" };
      }
      return await getSlackRuntime().channel.slack.probeSlack(token, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const mode = account.config.mode ?? "socket";
      const configured =
        (mode === "http"
          ? resolveConfiguredFromRequiredCredentialStatuses(account, [
              "botTokenStatus",
              "signingSecretStatus",
            ])
          : resolveConfiguredFromRequiredCredentialStatuses(account, [
              "botTokenStatus",
              "appTokenStatus",
            ])) ?? isSlackAccountConfigured(account);
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        runtime,
        probe,
      });
      return {
        ...base,
        ...projectCredentialSnapshotFields(account),
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const botToken = account.botToken?.trim();
      const appToken = account.appToken?.trim();
      ctx.log?.info(`[${account.accountId}] starting provider`);
      return getSlackRuntime().channel.slack.monitorSlackProvider({
        botToken: botToken ?? "",
        appToken: appToken ?? "",
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        slashCommand: account.config.slashCommand,
        setStatus: ctx.setStatus as (next: Record<string, unknown>) => void,
        getStatus: ctx.getStatus as () => Record<string, unknown>,
      });
    },
  },
};
