import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  clearAccountFieldsFromConfigSection,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderRouteAllowlistWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  isNextcloudTalkAccountConfigured,
  type ResolvedNextcloudTalkAccount,
  inspectNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import { DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "./channel-api.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { nextcloudTalkMessageActions } from "./message-actions.js";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
} from "./normalize.js";
import {
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkGroupToolPolicy,
} from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import { nextcloudTalkSetupContract } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

function sendNextcloudTalkMessage(
  ctx: Omit<ChannelMessageSendTextContext, "onDeliveryResult">,
  text = ctx.text,
) {
  return sendMessageNextcloudTalk(ctx.to, text, {
    accountId: ctx.accountId ?? undefined,
    replyTo: ctx.replyToId ?? undefined,
    cfg: ctx.cfg,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
  });
}

const nextcloudTalkMessageAdapter = defineChannelMessageAdapter({
  id: "nextcloud-talk",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: sendNextcloudTalkMessage,
    media: (ctx) =>
      sendNextcloudTalkMessage(
        ctx,
        ctx.mediaUrl ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}` : ctx.text,
      ),
  },
});

const meta = {
  id: "nextcloud-talk",
  label: "Nextcloud Talk",
  selectionLabel: "Nextcloud Talk (self-hosted)",
  docsPath: "/channels/nextcloud-talk",
  docsLabel: "nextcloud-talk",
  blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
  aliases: ["nc-talk", "nc"],
  order: 65,
  quickstartAllowFrom: true,
};

const collectNextcloudTalkSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedNextcloudTalkAccount>({
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
    restrictSenders: {
      surface: "Nextcloud Talk rooms",
      openScope: "any member in allowed rooms",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Nextcloud Talk rooms",
      routeAllowlistPath: "channels.nextcloud-talk.rooms",
      routeScope: "room",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
  });
const collectNextcloudTalkOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectNextcloudTalkSecurityWarnings,
  checkId: "channels.nextcloud-talk.groups.open",
  severity: "warn",
  title: "Nextcloud Talk security warning",
});

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> =
  createChatChannelPlugin({
    base: {
      id: "nextcloud-talk",
      meta,
      setupWizard: nextcloudTalkSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        reactions: true,
        threads: false,
        media: true,
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.nextcloud-talk"] },
      configSchema: NextcloudTalkChannelConfigSchema,
      config: {
        ...createScopedChannelConfigAdapter<
          ResolvedNextcloudTalkAccount,
          ResolvedNextcloudTalkAccount,
          CoreConfig
        >({
          sectionKey: "nextcloud-talk",
          listAccountIds: listNextcloudTalkAccountIds,
          resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
          inspectAccount: (cfg, accountId) => {
            const account = inspectNextcloudTalkAccount({ cfg, accountId });
            // Diagnostics expose presence only; operational callers retain the actual server URL.
            return { ...account, baseUrl: account.baseUrl ? "[set]" : "[missing]" };
          },
          defaultAccountId: resolveDefaultNextcloudTalkAccountId,
          clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
          resolveAllowFrom: (account) => account.config.allowFrom,
          formatAllowFrom: (allowFrom) =>
            formatAllowFromLowercase({
              allowFrom,
              stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
            }),
        }),
        isConfigured: isNextcloudTalkAccountConfigured,
        describeAccount: (account) =>
          describeWebhookAccountSnapshot({
            account,
            configured: isNextcloudTalkAccountConfigured(account),
            extra: {
              secretSource: account.secretSource,
              tokenStatus: account.tokenStatus,
              apiCredentialStatus: account.apiCredentialStatus,
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
            },
          }),
      },
      approvalCapability: nextcloudTalkApprovalAuth,
      doctor: nextcloudTalkDoctor,
      groups: {
        resolveRequireMention: resolveNextcloudTalkGroupRequireMention,
        resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
      },
      messaging: {
        targetPrefixes: ["nextcloud-talk", "nc-talk", "nc"],
        normalizeTarget: normalizeNextcloudTalkMessagingTarget,
        inferTargetChatType: ({ to }) =>
          normalizeNextcloudTalkMessagingTarget(to) ? "group" : undefined,
        resolveOutboundSessionRoute: resolveNextcloudTalkOutboundSessionRoute,
        targetResolver: {
          looksLikeId: looksLikeNextcloudTalkTargetId,
          hint: "<roomToken>",
        },
      },
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      setupContract: nextcloudTalkSetupContract,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) =>
          buildWebhookChannelStatusSummary(snapshot, {
            secretSource: snapshot.secretSource ?? "none",
          }),
        collectStatusIssues: (accounts) =>
          accounts.flatMap((account) => {
            const probe = account.probe as
              | { ok?: boolean; code?: string; message?: string }
              | undefined;
            if (
              !probe ||
              probe.ok !== false ||
              probe.code !== "missing_response_feature" ||
              !probe.message
            ) {
              return [];
            }
            return [
              {
                channel: "nextcloud-talk",
                accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
                kind: "config",
                message: probe.message,
                fix: "Add --feature response to the Talk bot.",
              } as const,
            ];
          }),
        probeAccount: async ({ account, timeoutMs }) =>
          await probeNextcloudTalkBotResponseFeature({ account, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: isNextcloudTalkAccountConfigured(account),
          extra: {
            secretSource: account.secretSource,
            tokenStatus: account.tokenStatus,
            apiCredentialStatus: account.apiCredentialStatus,
            baseUrl: account.baseUrl ? "[set]" : "[missing]",
            mode: "webhook",
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          if (!account.secret || !account.baseUrl) {
            throw new Error(
              `Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`,
            );
          }

          ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk Gateway webhook route`);

          const statusSink = createAccountStatusSink(ctx);

          await runPassiveAccountLifecycle({
            abortSignal: ctx.abortSignal,
            start: async () =>
              await monitorNextcloudTalkProvider({
                accountId: account.accountId,
                config: ctx.cfg,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
                statusSink,
              }),
            stop: async (monitor) => {
              await monitor.stop();
            },
          });
        },
        logoutAccount: async ({ accountId, cfg }) => {
          const { nextConfig, changed, cleared } = clearAccountFieldsFromConfigSection({
            cfg,
            sectionKey: "nextcloud-talk",
            accountId,
            fields: ["botSecret"],
          });

          const resolved = resolveNextcloudTalkAccount({
            cfg: nextConfig,
            accountId,
          });
          const loggedOut = resolved.secretSource === "none";

          if (changed) {
            await getNextcloudTalkRuntime().config.replaceConfigFile({
              nextConfig,
              afterWrite: { mode: "auto" },
            });
          }

          return {
            cleared,
            envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
            loggedOut,
          };
        },
      },
      message: nextcloudTalkMessageAdapter,
      actions: nextcloudTalkMessageActions,
    },
    pairing: {
      text: {
        idLabel: "nextcloudUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: createPairingPrefixStripper(
          /^(nextcloud-talk|nc-talk|nc):/i,
          (entry) => normalizeLowercaseStringOrEmpty(entry),
        ),
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      resolveDmPolicy: createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
        channelKey: "nextcloud-talk",
        resolvePolicy: (account) => account.config.dmPolicy,
        resolveAllowFrom: (account) => account.config.allowFrom,
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) =>
          normalizeLowercaseStringOrEmpty(raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, "")),
      }),
      collectWarnings: collectNextcloudTalkOpenGroupFindings,
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) =>
          getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        textChunkLimit: 4000,
        sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
      },
      attachedResults: {
        channel: "nextcloud-talk",
        sendText: nextcloudTalkMessageAdapter.send.text,
        sendMedia: (ctx) =>
          nextcloudTalkMessageAdapter.send.media({
            ...ctx,
            mediaUrl: ctx.mediaUrl ?? "",
            onDeliveryResult: undefined,
          }),
      },
    },
  });
