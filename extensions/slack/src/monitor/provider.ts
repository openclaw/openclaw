// Slack provider module implements model/runtime integration.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig, SessionScope } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { installRequestBodyLimitGuard } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  listEnabledSlackAccounts,
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "../accounts.js";
import { isSlackAnyNativeApprovalClientEnabled } from "../approval-native-gates.js";
import { resolveSlackWebClientOptions } from "../client-options.js";
import { createSlackWebClient } from "../client.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist, type SlackUserResolution } from "../resolve-users.js";
import {
  formatSlackBotTokenIdentityWarning,
  resolveSlackAppToken,
  resolveSlackBotToken,
} from "../token.js";
import { normalizeAllowList } from "./allow-list.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import {
  getRuntimeConfig,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./config.runtime.js";
import { createSlackMonitorContext } from "./context.js";
import {
  assertEnterpriseSlackDmPolicy,
  assertEnterpriseSlackPolicyConfig,
  assertNoEnterpriseSlackBindings,
  resolveSlackInstallationIdentity,
  type SlackAuthTestIdentity,
} from "./enterprise-install.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createSlackBoltApp,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
  type SlackBoltResolvedExports,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  formatUnknownError,
  registerSlackSocketModeConnectionDiagnostics,
} from "./reconnect-policy.js";
import { setSlackDefaultSendIdentity } from "./send.runtime.js";
import {
  forceStopSlackSharedSocketGroup,
  joinSlackSharedSocketGroup,
  runSlackSocketConnectionLoop,
  type SlackSharedSocketGroupHandle,
} from "./shared-socket-group.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

let slackBoltInterop: SlackBoltResolvedExports | undefined;

async function getSlackBoltInterop(): Promise<SlackBoltResolvedExports> {
  if (!slackBoltInterop) {
    const slackBoltModule = await import("@slack/bolt");
    slackBoltInterop = resolveSlackBoltInterop({
      defaultImport: slackBoltModule.default,
      namespaceImport: slackBoltModule,
    });
  }
  return slackBoltInterop;
}

type SlackBoltAppBundle = ReturnType<typeof createSlackBoltApp>;

const loadSlackRelaySource = createLazyRuntimeModule(() => import("./relay-source.js"));

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function resolveStableSlackUserIdEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const mention = /^<@([A-Z][A-Z0-9]+)>$/i.exec(trimmed);
  if (mention) {
    return mention[1]?.toUpperCase();
  }
  const prefixed = /^(?:slack:|user:)([A-Z][A-Z0-9]+)$/i.exec(trimmed);
  if (prefixed) {
    return prefixed[1]?.toUpperCase();
  }
  return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

function resolveStableSlackUserAllowlistEntries(entries: string[]): SlackUserResolution[] {
  const resolved: SlackUserResolution[] = [];
  for (const input of entries) {
    const id = resolveStableSlackUserIdEntry(input);
    if (id) {
      resolved.push({ input, resolved: true, id });
    }
  }
  return resolved;
}

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

/**
 * Counts enabled Socket Mode accounts (across the whole `channels.slack`
 * config, not just the account currently booting) that resolve to the same
 * app token as `appToken`. Grouping into a shared Socket Mode connection is
 * only engaged when this is greater than 1 — a single account per app token
 * takes the original, unmodified code path with zero behavioral change.
 */
function countEnabledSlackSocketAccountsSharingAppToken(params: {
  cfg: OpenClawConfig;
  appToken: string;
}): number {
  return listEnabledSlackAccounts(params.cfg).filter((candidate) => {
    const mode = candidate.config.mode ?? "socket";
    return mode === "socket" && candidate.appToken === params.appToken;
  }).length;
}

function resolveSlackRelayConfig(params: { relay: unknown; accountId: string }): {
  url: string;
  authToken: string;
  gatewayId: string;
} {
  const relay =
    params.relay && typeof params.relay === "object" && !Array.isArray(params.relay)
      ? (params.relay as Record<string, unknown>)
      : {};
  const url = normalizeOptionalString(relay.url);
  const authToken = normalizeResolvedSecretInputString({
    value: relay.authToken,
    path: `channels.slack.accounts.${params.accountId}.relay.authToken`,
  });
  const gatewayId = normalizeOptionalString(relay.gatewayId);
  if (!url || !authToken || !gatewayId) {
    throw new Error(
      `Slack relay mode requires relay.url, relay.authToken, and relay.gatewayId for account "${params.accountId}".`,
    );
  }
  return {
    url,
    authToken,
    gatewayId,
  };
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? getRuntimeConfig();
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.enabled) {
    runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
    if (opts.abortSignal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return;
  }

  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const dmHistoryLimit = Math.max(0, account.config.dmHistoryLimit ?? 0);

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const enterpriseOrgInstall = account.config.enterpriseOrgInstall === true;
  if (enterpriseOrgInstall && slackMode === "relay") {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" requires direct socket or HTTP delivery; relay mode is unsupported`,
    );
  }
  if (enterpriseOrgInstall && account.config.execApprovals?.enabled === true) {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" does not support Slack-native exec approvals`,
    );
  }
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackPolicyConfig({ config: account.config, accountId: account.accountId });
    assertNoEnterpriseSlackBindings({ cfg, accountId: account.accountId });
  }
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = normalizeResolvedSecretInputString({
    value: account.config.signingSecret,
    path: `channels.slack.accounts.${account.accountId}.signingSecret`,
  });
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  const relayConfig =
    slackMode === "relay"
      ? resolveSlackRelayConfig({
          relay: account.config.relay,
          accountId: account.accountId,
        })
      : undefined;
  if (!botToken || (slackMode === "socket" && !appToken)) {
    const missing =
      slackMode === "http"
        ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
        : slackMode === "relay"
          ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
          : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
    throw new Error(missing);
  }
  if (slackMode === "http" && !signingSecret) {
    throw new Error(
      `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
    );
  }

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;

  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: account.accountId }) ?? "pairing";
  let allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: account.accountId });
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackDmPolicy({
      accountId: account.accountId,
      dmEnabled,
      dmPolicy,
      allowFrom,
    });
  }
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.slack !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: slackCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "slack",
    accountId: account.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });

  const resolveToken = account.userToken || botToken;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const threadRequireExplicitMention = slackCfg.thread?.requireExplicitMention ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const allowNameMatching = isDangerousNameMatchingEnabled(slackCfg);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const typingReaction = slackCfg.typingReaction?.trim() ?? "";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const clientOptions = resolveSlackWebClientOptions();
  const expectedApiAppIdFromAppToken =
    slackMode === "socket" ? parseApiAppIdFromAppToken(appToken) : undefined;

  // Per-account Web API client bound to THIS account's own bot token. Used
  // for the boot-time auth.test() call below and handed to the monitor
  // context (ctx.client) so every inbound-side Web API call authenticates as
  // this account, regardless of whether its Bolt App ends up shared with
  // other accounts (see isSharedSlackSocketAppToken below).
  const accountWebClient = createSlackWebClient(botToken, clientOptions);

  // Slack Socket Mode delivers each event to exactly one open connection for
  // an app (it load-balances, it does not fan out). If two accounts open two
  // Socket Mode connections for the SAME app token, each drops ~half the
  // traffic via shouldDropMismatchedSlackEvent's team_id filter. Detect that
  // configuration up front (purely from static config, so every sibling
  // account computes the same answer) and, only then, share a single Bolt
  // App/connection across all of them. A single account per app token takes
  // the untouched original code path below with no behavioral change.
  const isSharedSlackSocketAppToken =
    slackMode === "socket" &&
    Boolean(appToken) &&
    countEnabledSlackSocketAccountsSharingAppToken({ cfg, appToken: appToken ?? "" }) > 1;

  let app: SlackBoltAppBundle["app"];
  let receiver: SlackBoltAppBundle["receiver"];
  let socketModeLogger: SlackBoltAppBundle["socketModeLogger"];
  let sharedGroup: SlackSharedSocketGroupHandle<SlackBoltAppBundle> | null = null;

  if (isSharedSlackSocketAppToken) {
    sharedGroup = await joinSlackSharedSocketGroup<SlackBoltAppBundle>({
      appToken: appToken as string,
      accountId: account.accountId,
      createAppBundle: async () =>
        createSlackBoltApp({
          interop: await getSlackBoltInterop(),
          slackMode,
          botToken,
          appToken: appToken ?? undefined,
          slackWebhookPath,
          clientOptions: clientOptions as Record<string, unknown>,
          ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
        }),
    });
    ({ app, receiver, socketModeLogger } = sharedGroup.appBundle);
  } else {
    ({ app, receiver, socketModeLogger } = createSlackBoltApp({
      interop: await getSlackBoltInterop(),
      slackMode,
      botToken,
      appToken: slackMode === "socket" ? (appToken ?? undefined) : undefined,
      signingSecret: slackMode === "http" ? (signingSecret ?? undefined) : undefined,
      slackWebhookPath,
      clientOptions: clientOptions as Record<string, unknown>,
      ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
    }));
  }

  // Members of a shared group must never start/stop/diagnose a connection
  // another account created. For a solo (non-shared) account, sharedGroup is
  // null and every one of these checks degrades to the original
  // single-account behavior.
  const isSharedGroupMember = sharedGroup !== null && !sharedGroup.isOwner;

  // Pre-set shuttingDown on the SocketModeClient before app.stop() to prevent
  // a race where the library's internal ping timeout fires disconnect() before
  // shuttingDown is set, causing orphaned reconnects with leaked ping intervals.
  // See: openclaw/openclaw#56508
  const gracefulStop = async () => {
    if (sharedGroup) {
      // The group-owned connection task stops the shared App; individual
      // accounts (creator included) never stop an App siblings may be using.
      return;
    }
    await gracefulStopSlackApp(app);
  };
  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void gracefulStop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  // Everything between joining the shared group (above; only non-throwing
  // statements may sit in between) and this try runs under the finally at the
  // end of this function, so any thrown error releases the group
  // reservation: a creator that throws before its connection task exists
  // tears the whole group down so members are never left waiting on a
  // stopSignal nobody will fire, and a member that throws simply leaves.
  let unregisterHttpHandler: (() => void) | null = null;
  let unregisterSocketModeConnectionDiagnostics: () => void = () => {};
  try {
    if (sharedGroup?.justBecameShared) {
      // Deliberately inside the try: runtime.log is caller-supplied and may
      // throw, and a member that dies here must still leave the group.
      const sharedAccountCount = countEnabledSlackSocketAccountsSharingAppToken({
        cfg,
        appToken: appToken ?? "",
      });
      runtime.log?.(
        `slack: sharing socket for ${sharedAccountCount} accounts on app ` +
          `${expectedApiAppIdFromAppToken ?? "unknown"} (multi-workspace)`,
      );
    }

    const slackHttpHandler =
      slackMode === "http" && receiver
        ? async (req: IncomingMessage, res: ServerResponse) => {
            const httpReceiver = receiver as {
              requestListener: (req: IncomingMessage, res: ServerResponse) => unknown;
            };
            const guard = installRequestBodyLimitGuard(req, res, {
              maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
              timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
              responseFormat: "text",
            });
            if (guard.isTripped()) {
              return;
            }
            try {
              await Promise.resolve(httpReceiver.requestListener(req, res));
            } catch (err) {
              if (!guard.isTripped()) {
                throw err;
              }
            } finally {
              guard.dispose();
            }
          }
        : null;
    // Only the group creator (or a non-shared solo account) registers
    // diagnostics: a shared group has exactly one physical connection, so a
    // member registering its own listener on the same emitter would be
    // redundant.
    unregisterSocketModeConnectionDiagnostics =
      slackMode === "socket" && !isSharedGroupMember
        ? registerSlackSocketModeConnectionDiagnostics({
            app,
            onSharedConnection: (activeConnections) => {
              runtime.log?.(warn(formatSlackSocketModeSharedConnectionWarning(activeConnections)));
            },
          })
        : () => {};

    let botUserId = "";
    let botId = "";
    let authTestFailed = false;
    let authTestError: string | undefined;
    let authIdentityWarning: string | undefined;
    let authTestIdentity: SlackAuthTestIdentity | undefined;
    try {
      // Always authenticate via this account's OWN per-account client, never
      // app.client: when the App is shared, app.client's default identity is
      // whichever account created it (the group owner), which would make every
      // member account boot up believing it is the owner's team/app.
      const auth = await accountWebClient.auth.test();
      const authUserId = normalizeOptionalString(auth.user_id) ?? "";
      botId = normalizeOptionalString((auth as { bot_id?: string }).bot_id) ?? "";
      // Slack documents bot_id only for bot-token identities. Never treat the user behind a
      // user token as the bot mention target; required-mention channels must fail closed instead.
      botUserId = botId ? authUserId : "";
      authTestIdentity = auth;
      authIdentityWarning = formatSlackBotTokenIdentityWarning({
        auth,
        accountId: account.accountId,
      });
      if (!authUserId && !enterpriseOrgInstall) {
        authTestFailed = true;
        authTestError = "auth.test returned no user_id";
      }
    } catch (err) {
      authTestFailed = true;
      authTestError = err instanceof Error ? err.message : String(err);
    }
    const installationIdentity = resolveSlackInstallationIdentity({
      enterpriseOrgInstall,
      auth: authTestFailed ? undefined : authTestIdentity,
      authError: authTestError,
      transportApiAppId: expectedApiAppIdFromAppToken,
    });
    const teamId = installationIdentity.kind === "workspace" ? installationIdentity.teamId : "";
    const apiAppId =
      installationIdentity.kind === "degraded" ? "" : (installationIdentity.apiAppId ?? "");
    if (authTestFailed) {
      runtime.log?.(
        warn(
          `[${account.accountId}] slack auth.test failed at boot (${authTestError ?? "unknown error"}); ` +
            "explicit bot-mention detection will be disabled until restart with a valid bot token; " +
            "required-mention channels will fail closed without another trusted activation signal",
        ),
      );
    }
    if (authIdentityWarning) {
      runtime.log?.(warn(authIdentityWarning));
    }

    if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
      runtime.error?.(
        `slack token mismatch: bot token app_id=${apiAppId} but app token looks like app_id=${expectedApiAppIdFromAppToken}`,
      );
    }

    if (isSharedSlackSocketAppToken && !teamId) {
      runtime.log?.(
        warn(
          `[${account.accountId}] slack: teamId unresolved on a shared socket group (auth.test failed or returned no team_id); ` +
            "ALL events for this account will be dropped to avoid acting on sibling workspaces' traffic — " +
            "fix the bot token and restart",
        ),
      );
    }

    const ctx = createSlackMonitorContext({
      cfg,
      accountId: account.accountId,
      botToken,
      app,
      client: accountWebClient,
      runtime,
      channelRuntime: opts.channelRuntime,
      accountAbortSignal: opts.abortSignal,
      isSharedSocketGroup: isSharedSlackSocketAppToken,
      botUserId,
      botId,
      teamId,
      apiAppId,
      installationIdentity,
      historyLimit,
      dmHistoryLimit,
      sessionScope,
      mainKey,
      dmEnabled,
      dmPolicy,
      allowFrom,
      allowNameMatching,
      groupDmEnabled,
      groupDmChannels,
      defaultRequireMention: slackCfg.requireMention,
      channelsConfig,
      groupPolicy,
      useAccessGroups,
      reactionMode,
      reactionAllowlist,
      replyToMode,
      threadHistoryScope,
      threadInheritParent,
      threadRequireExplicitMention,
      slashCommand,
      textLimit,
      ackReactionScope,
      typingReaction,
      mediaMaxBytes,
      removeAckAfterReply,
    });

    // Slack's socket-mode client keeps ping/pong health private and closes on
    // missed pongs. App events are useful status activity, but not transport proof.
    const trackEvent = opts.setStatus
      ? () => {
          opts.setStatus!({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
        }
      : undefined;

    const handleSlackMessage = createSlackMessageHandler({ ctx, account, trackEvent });
    if (
      installationIdentity.kind !== "enterprise" &&
      isSlackAnyNativeApprovalClientEnabled({
        cfg,
        accountId: account.accountId,
      })
    ) {
      registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "slack",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {
          // The approval runtime must call the Web API as THIS account, not as
          // whichever account owns a shared App — pass the per-account client
          // alongside the (possibly shared) App.
          app,
          client: accountWebClient,
          config: slackCfg.execApprovals ?? {},
        },
        abortSignal: opts.abortSignal,
      });
    }

    // Resolve command registration first so App Home never advertises an inactive single command.
    const commandRegistration =
      installationIdentity.kind === "enterprise"
        ? ({ mode: "disabled" } as const)
        : await registerSlackMonitorSlashCommands({ ctx, account, trackEvent });
    const appHomeSlashCommandName =
      commandRegistration.mode === "single" ? commandRegistration.name : undefined;
    registerSlackMonitorEvents({
      ctx,
      account,
      handleSlackMessage,
      appHomeSlashCommandName,
      trackEvent,
    });
    if (slackMode === "http" && slackHttpHandler) {
      unregisterHttpHandler = registerSlackHttpHandler({
        path: slackWebhookPath,
        handler: slackHttpHandler,
        log: runtime.log,
        accountId: account.accountId,
      });
    }

    if (resolveToken && installationIdentity.kind !== "enterprise") {
      void (async () => {
        if (opts.abortSignal?.aborted) {
          return;
        }

        if (channelsConfig && Object.keys(channelsConfig).length > 0) {
          try {
            const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
            if (entries.length > 0) {
              const resolved = await resolveSlackChannelAllowlist({
                token: resolveToken,
                entries,
              });
              const nextChannels = { ...channelsConfig };
              const mapping: string[] = [];
              const unresolved: string[] = [];
              for (const entry of resolved) {
                const source = channelsConfig?.[entry.input];
                if (!source) {
                  continue;
                }
                if (!entry.resolved || !entry.id) {
                  unresolved.push(entry.input);
                  continue;
                }
                const resolvedLabel = formatSlackChannelResolved(entry);
                if (resolvedLabel) {
                  mapping.push(resolvedLabel);
                }
                const existing = nextChannels[entry.id] ?? {};
                nextChannels[entry.id] = { ...source, ...existing };
              }
              channelsConfig = nextChannels;
              ctx.channelsConfig = nextChannels;
              summarizeMapping("slack channels", mapping, unresolved, runtime);
            }
          } catch (err) {
            runtime.log?.(
              `slack channel resolve failed; using config entries. ${formatUnknownError(err)}`,
            );
          }
        }

        const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
        if (allowEntries.length > 0) {
          const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(allowEntries);
          if (stableResolvedUsers.length > 0) {
            const { mapping, additions } = buildAllowlistResolutionSummary(stableResolvedUsers, {
              formatResolved: formatSlackUserResolved,
            });
            allowFrom = mergeAllowlist({ existing: allowFrom, additions });
            ctx.allowFrom = normalizeAllowList(allowFrom);
            summarizeMapping("slack users", mapping, [], runtime);
          }

          if (allowNameMatching) {
            try {
              const resolvedUsers = await resolveSlackUserAllowlist({
                token: resolveToken,
                entries: allowEntries,
              });
              const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(
                resolvedUsers,
                {
                  formatResolved: formatSlackUserResolved,
                },
              );
              allowFrom = mergeAllowlist({ existing: allowFrom, additions });
              ctx.allowFrom = normalizeAllowList(allowFrom);
              summarizeMapping("slack users", mapping, unresolved, runtime);
            } catch (err) {
              runtime.log?.(
                `slack user resolve failed; using config entries. ${formatUnknownError(err)}`,
              );
            }
          }
        }

        if (channelsConfig && Object.keys(channelsConfig).length > 0) {
          const userEntries = new Set<string>();
          for (const channel of Object.values(channelsConfig)) {
            addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
          }

          if (userEntries.size > 0) {
            const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(
              Array.from(userEntries),
            );
            if (stableResolvedUsers.length > 0) {
              const { resolvedMap, mapping } = buildAllowlistResolutionSummary(
                stableResolvedUsers,
                {
                  formatResolved: formatSlackUserResolved,
                },
              );
              const nextChannels = patchAllowlistUsersInConfigEntries({
                entries: channelsConfig,
                resolvedMap,
              });
              channelsConfig = nextChannels;
              ctx.channelsConfig = nextChannels;
              summarizeMapping("slack channel users", mapping, [], runtime);
            }

            if (allowNameMatching) {
              try {
                const resolvedUsers = await resolveSlackUserAllowlist({
                  token: resolveToken,
                  entries: Array.from(userEntries),
                });
                const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(
                  resolvedUsers,
                  {
                    formatResolved: formatSlackUserResolved,
                  },
                );

                const nextChannels = patchAllowlistUsersInConfigEntries({
                  entries: channelsConfig,
                  resolvedMap,
                });
                channelsConfig = nextChannels;
                ctx.channelsConfig = nextChannels;
                summarizeMapping("slack channel users", mapping, unresolved, runtime);
              } catch (err) {
                runtime.log?.(
                  `slack channel user resolve failed; using config entries. ${formatUnknownError(err)}`,
                );
              }
            }
          }
        }
      })();
    }

    if (slackMode === "socket" && sharedGroup) {
      const group = sharedGroup;
      if (group.isOwner) {
        // The connection runs as a GROUP-owned task, decoupled from this
        // account's lifecycle: it keeps serving sibling accounts after this
        // creator account is stopped, and only ends once every member has
        // left (or a fatal error kills it). It intentionally keeps using the
        // CREATOR's runtime for logs and the creator's setStatus for
        // connection status even after the creator account itself stops.
        group.startConnectionTask(async () => {
          // Pre-set shuttingDown as soon as the group stops (same race guard
          // as stopOnAbort above, but keyed to the group's lifetime).
          const stopOnGroupStop = () => {
            void gracefulStopSlackApp(app);
          };
          group.stopSignal.addEventListener("abort", stopOnGroupStop, { once: true });
          try {
            await runSlackSocketConnectionLoop({
              app,
              abortSignal: group.stopSignal,
              runtime,
              setStatus: opts.setStatus,
              getLastSdkLogMessage: socketModeLogger.getLastMessage,
            });
          } finally {
            group.stopSignal.removeEventListener("abort", stopOnGroupStop);
            await gracefulStopSlackApp(app);
          }
        });
      }
      // Every sharing account — creator included — waits passively until its
      // OWN abort signal fires (per-account stop resolves this monitor
      // promise immediately; the shared socket lives on for siblings) or the
      // group's stopSignal fires (last member left, or the connection task
      // died). Both listeners are removed on settle so neither signal
      // accumulates stale callbacks.
      if (!opts.abortSignal?.aborted && !group.stopSignal.aborted) {
        await new Promise<void>((resolve) => {
          const settle = () => {
            opts.abortSignal?.removeEventListener("abort", settle);
            group.stopSignal.removeEventListener("abort", settle);
            resolve();
          };
          opts.abortSignal?.addEventListener("abort", settle, { once: true });
          group.stopSignal.addEventListener("abort", settle, { once: true });
        });
      }
      // Surface a fatal connection-task failure (e.g. non-recoverable auth
      // error) on every sharing account's monitor promise — unless this
      // account was stopped on purpose, in which case it exits cleanly.
      const stopError = group.getStopError();
      if (stopError !== undefined && !opts.abortSignal?.aborted) {
        throw stopError instanceof Error ? stopError : new Error(formatUnknownError(stopError));
      }
    } else if (slackMode === "socket") {
      await runSlackSocketConnectionLoop({
        app,
        abortSignal: opts.abortSignal,
        runtime,
        setStatus: opts.setStatus,
        getLastSdkLogMessage: socketModeLogger.getLastMessage,
      });
    } else if (slackMode === "relay" && relayConfig) {
      runtime.log?.(
        `slack relay mode connecting to ${relayConfig.url} gateway_id:${relayConfig.gatewayId}`,
      );
      await (
        await loadSlackRelaySource()
      ).monitorSlackRelaySource({
        config: relayConfig,
        handleSlackMessage,
        runtime,
        abortSignal: opts.abortSignal,
        setStatus: opts.setStatus,
        setIdentity: (identity) => setSlackDefaultSendIdentity(account.accountId, identity),
      });
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
      if (!opts.abortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    }
  } finally {
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterSocketModeConnectionDiagnostics();
    unregisterHttpHandler?.();
    if (sharedGroup) {
      if (sharedGroup.isOwner && !sharedGroup.hasConnectionTask()) {
        // This account created the group but threw before the connection
        // task existed: tear the group down so members are never left
        // waiting forever on a stopSignal nobody will fire. Once the task
        // runs, its own finally performs the teardown and a plain leave()
        // below is correct even for the creator.
        forceStopSlackSharedSocketGroup({ appToken: appToken as string });
      } else {
        sharedGroup.leave();
      }
    }
    await gracefulStop();
  }
}

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
