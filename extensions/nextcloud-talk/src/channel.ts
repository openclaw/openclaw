import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  clearAccountFieldsFromConfigSection,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
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
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
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
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import { DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "./channel-api.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { nextcloudTalkMessageActions } from "./message-actions.js";
import { registerNextcloudTalkWebhook } from "./monitor.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
  stripNextcloudTalkTargetPrefix,
} from "./normalize.js";
import {
  normalizeNextcloudTalkAllowEntry,
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkGroupToolPolicy,
} from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { nextcloudTalkSetupContract } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";
import {
  DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH,
  describeNextcloudTalkWebhookRouteConflict,
  resolveNextcloudTalkLegacyWebhook,
} from "./webhook-route.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

const nextcloudTalkApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Nextcloud Talk",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveNextcloudTalkAccount({ cfg, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: (value) => normalizeNextcloudTalkAllowEntry(String(value)) || undefined,
}).approvalAuth;

function resolveNextcloudTalkOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    // Room tokens do not reveal whether inbound keys by room or sender id.
    // Keep delivery behavior, but reject this route for explicit session selection.
    recipientSessionExact: false,
    peer: {
      kind: "group",
      id: roomId,
    },
    chatType: "group",
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  });
}

function normalizeOrigin(value: string): string | null {
  return URL.parse(value)?.origin.toLowerCase() ?? null;
}

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

function isWebAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
      })
    );
  } catch {
    return false;
  }
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
    media: async (ctx) => {
      if (!ctx.mediaUrl) {
        return sendNextcloudTalkMessage(ctx);
      }
      const account = resolveNextcloudTalkAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (
        account.enabled &&
        !account.config.apiUser?.trim() &&
        account.config.apiPassword === undefined &&
        !account.config.apiPasswordFile?.trim() &&
        isWebAttachmentUrl(ctx.mediaUrl)
      ) {
        ctx.signal?.throwIfAborted();
        return sendNextcloudTalkMessage(
          {
            ...ctx,
            assertDirectAdapterHandoff: () => {
              ctx.signal?.throwIfAborted();
              ctx.assertDirectAdapterHandoff?.();
            },
          },
          `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}`,
        );
      }
      const { sendMediaNextcloudTalk } = await import("./outbound-media.js");
      return sendMediaNextcloudTalk(ctx);
    },
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
          formatAllowFrom: normalizeNextcloudTalkAllowlist,
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
            start: async () => {
              const core = getNextcloudTalkRuntime();
              const cfg = ctx.cfg;
              const monitoredAccount = resolveNextcloudTalkAccount({
                cfg,
                accountId: account.accountId,
              });
              const runtime = resolveLoggerBackedRuntime(
                ctx.runtime,
                core.logging.getChildLogger(),
              );
              if (!monitoredAccount.secret) {
                throw new Error(
                  `Nextcloud Talk bot secret not configured for account "${monitoredAccount.accountId}"`,
                );
              }
              const path =
                monitoredAccount.config.webhookPath ?? DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH;
              const gatewayPort = resolveGatewayPort({ gateway: cfg.gateway });
              const legacyListener = resolveNextcloudTalkLegacyWebhook(monitoredAccount.config);
              const routeConflict = describeNextcloudTalkWebhookRouteConflict(path, gatewayPort);
              if (routeConflict && !legacyListener) {
                throw new Error(`[nextcloud-talk:${monitoredAccount.accountId}] ${routeConflict}`);
              }
              const logger = core.logging.getChildLogger({
                channel: "nextcloud-talk",
                accountId: monitoredAccount.accountId,
              });
              const expectedBackendOrigin = normalizeOrigin(monitoredAccount.baseUrl);
              const spool = createNextcloudTalkWebhookSpool({
                accountId: monitoredAccount.accountId,
                runtime,
                abortSignal: ctx.abortSignal,
                deliver: async (message, lifecycle) => {
                  core.channel.activity.record({
                    channel: "nextcloud-talk",
                    accountId: monitoredAccount.accountId,
                    direction: "inbound",
                    at: message.timestamp,
                  });
                  await handleNextcloudTalkInbound({
                    message,
                    account: monitoredAccount,
                    config: cfg,
                    runtime,
                    statusSink,
                    turnAdoptionLifecycle: lifecycle,
                  });
                },
              });
              let unregister: (() => Promise<void>) | undefined;
              let stopPromise: Promise<void> | undefined;
              const stop = () => {
                stopPromise ??= (async () => {
                  await unregister?.();
                  unregister = undefined;
                  await spool.stop();
                })();
                return stopPromise;
              };
              if (!ctx.abortSignal.aborted) {
                ctx.abortSignal.addEventListener("abort", () => void stop(), { once: true });
              }
              if (ctx.abortSignal.aborted) {
                await stop();
                return { stop };
              }
              try {
                await spool.ready();
                if (ctx.abortSignal.aborted) {
                  await stop();
                  return { stop };
                }
                unregister = registerNextcloudTalkWebhook({
                  accountId: monitoredAccount.accountId,
                  legacyListener,
                  path,
                  secret: monitoredAccount.secret,
                  isBackendAllowed: (backend) =>
                    !expectedBackendOrigin || normalizeOrigin(backend) === expectedBackendOrigin,
                  onWebhook: spool.receive,
                  onError: (error) => {
                    logger.error(
                      `[nextcloud-talk:${monitoredAccount.accountId}] webhook error: ${error.message}`,
                    );
                  },
                  trustedProxies: cfg.gateway?.trustedProxies,
                  allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
                });
              } catch (error) {
                await stop();
                throw error;
              }
              statusSink(channelReadyPatch());
              if (routeConflict && legacyListener) {
                logger.warn(
                  `[nextcloud-talk:${monitoredAccount.accountId}] ${routeConflict} ` +
                    `Legacy webhook listener ${legacyListener.host}:${legacyListener.port} remains available; verify the new route before removing the legacyWebhook pin.`,
                );
                return { stop };
              }
              logger.info(
                `[nextcloud-talk:${monitoredAccount.accountId}] Gateway webhook route ready at port ${gatewayPort}${path}; ` +
                  "point the Nextcloud bot callback or reverse-proxy upstream here.",
              );
              if (legacyListener) {
                logger.info(
                  `[nextcloud-talk:${monitoredAccount.accountId}] legacy webhook listener ${legacyListener.host}:${legacyListener.port} forwards to the Gateway route. ` +
                    "After verifying the callback or proxy upstream uses the Gateway port, remove the legacyWebhook pin; use legacyWebhook: false to override an inherited endpoint.",
                );
              }
              return { stop };
            },
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
        normalizeEntry: normalizeNextcloudTalkAllowEntry,
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
