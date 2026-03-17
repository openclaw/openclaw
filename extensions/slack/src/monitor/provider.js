import SlackBolt from "@slack/bolt";
import { resolveTextChunkLimit } from "../../../../src/auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "../../../../src/auto-reply/reply/history.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping
} from "../../../../src/channels/allowlists/resolve-utils.js";
import { loadConfig } from "../../../../src/config/config.js";
import { isDangerousNameMatchingEnabled } from "../../../../src/config/dangerous-name-matching.js";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce
} from "../../../../src/config/runtime-group-policy.js";
import { normalizeResolvedSecretInputString } from "../../../../src/config/types.secrets.js";
import { createConnectedChannelStatusPatch } from "../../../../src/gateway/channel-status-patches.js";
import { warn } from "../../../../src/globals.js";
import { computeBackoff, sleepWithAbort } from "../../../../src/infra/backoff.js";
import { installRequestBodyLimitGuard } from "../../../../src/infra/http-body.js";
import { normalizeMainKey } from "../../../../src/routing/session-key.js";
import { createNonExitingRuntime } from "../../../../src/runtime.js";
import { normalizeStringEntries } from "../../../../src/shared/string-normalization.js";
import { resolveSlackAccount } from "../accounts.js";
import { resolveSlackWebClientOptions } from "../client.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist } from "../resolve-users.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
import { normalizeAllowList } from "./allow-list.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  formatUnknownError,
  getSocketEmitter,
  isNonRecoverableSlackAuthError,
  SLACK_SOCKET_RECONNECT_POLICY,
  waitForSlackSocketDisconnect
} from "./reconnect-policy.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
const slackBoltModule = SlackBolt;
const slackBolt = (slackBoltModule.App ? slackBoltModule : slackBoltModule.default) ?? slackBoltModule;
const { App, HTTPReceiver } = slackBolt;
const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
function parseApiAppIdFromAppToken(raw) {
  const token = raw?.trim();
  if (!token) {
    return void 0;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}
function publishSlackConnectedStatus(setStatus) {
  if (!setStatus) {
    return;
  }
  const now = Date.now();
  setStatus({
    ...createConnectedChannelStatusPatch(now),
    lastError: null
  });
}
function publishSlackDisconnectedStatus(setStatus, error) {
  if (!setStatus) {
    return;
  }
  const at = Date.now();
  const message = error ? formatUnknownError(error) : void 0;
  setStatus({
    connected: false,
    lastDisconnect: message ? { at, error: message } : { at },
    lastError: message ?? null
  });
}
async function monitorSlackProvider(opts = {}) {
  const cfg = opts.config ?? loadConfig();
  const runtime = opts.runtime ?? createNonExitingRuntime();
  let account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId
  });
  if (!account.enabled) {
    runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
    if (opts.abortSignal?.aborted) {
      return;
    }
    await new Promise((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true
      });
    });
    return;
  }
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT
  );
  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = normalizeResolvedSecretInputString({
    value: account.config.signingSecret,
    path: `channels.slack.accounts.${account.accountId}.signingSecret`
  });
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  if (!botToken || slackMode !== "http" && !appToken) {
    const missing = slackMode === "http" ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).` : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
    throw new Error(missing);
  }
  if (slackMode === "http" && !signingSecret) {
    throw new Error(
      `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`
    );
  }
  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = slackCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
  let allowFrom = slackCfg.allowFrom ?? dmConfig?.allowFrom;
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.slack !== void 0;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: slackCfg.groupPolicy,
    defaultGroupPolicy
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "slack",
    accountId: account.accountId,
    log: (message) => runtime.log?.(warn(message))
  });
  const resolveToken = account.userToken || botToken;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const typingReaction = slackCfg.typingReaction?.trim() ?? "";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const receiver = slackMode === "http" ? new HTTPReceiver({
    signingSecret: signingSecret ?? "",
    endpoints: slackWebhookPath
  }) : null;
  const clientOptions = resolveSlackWebClientOptions();
  const app = new App(
    slackMode === "socket" ? {
      token: botToken,
      appToken,
      socketMode: true,
      clientOptions
    } : {
      token: botToken,
      receiver: receiver ?? void 0,
      clientOptions
    }
  );
  const slackHttpHandler = slackMode === "http" && receiver ? async (req, res) => {
    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text"
    });
    if (guard.isTripped()) {
      return;
    }
    try {
      await Promise.resolve(receiver.requestListener(req, res));
    } catch (err) {
      if (!guard.isTripped()) {
        throw err;
      }
    } finally {
      guard.dispose();
    }
  } : null;
  let unregisterHttpHandler = null;
  let botUserId = "";
  let teamId = "";
  let apiAppId = "";
  const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id ?? "";
    teamId = auth.team_id ?? "";
    apiAppId = auth.api_app_id ?? "";
  } catch {
  }
  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    runtime.error?.(
      `slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`
    );
  }
  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    botUserId,
    teamId,
    apiAppId,
    historyLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    allowNameMatching: isDangerousNameMatchingEnabled(slackCfg),
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
    slashCommand,
    textLimit,
    ackReactionScope,
    typingReaction,
    mediaMaxBytes,
    removeAckAfterReply
  });
  const trackEvent = opts.setStatus ? () => {
    opts.setStatus({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
  } : void 0;
  const handleSlackMessage = createSlackMessageHandler({ ctx, account, trackEvent });
  registerSlackMonitorEvents({ ctx, account, handleSlackMessage, trackEvent });
  await registerSlackMonitorSlashCommands({ ctx, account });
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      log: runtime.log,
      accountId: account.accountId
    });
  }
  if (resolveToken) {
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
              entries
            });
            const nextChannels = { ...channelsConfig };
            const mapping = [];
            const unresolved = [];
            for (const entry of resolved) {
              const source = channelsConfig?.[entry.input];
              if (!source) {
                continue;
              }
              if (!entry.resolved || !entry.id) {
                unresolved.push(entry.input);
                continue;
              }
              mapping.push(`${entry.input}\u2192${entry.id}${entry.archived ? " (archived)" : ""}`);
              const existing = nextChannels[entry.id] ?? {};
              nextChannels[entry.id] = { ...source, ...existing };
            }
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channels", mapping, unresolved, runtime);
          }
        } catch (err) {
          runtime.log?.(`slack channel resolve failed; using config entries. ${String(err)}`);
        }
      }
      const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
      if (allowEntries.length > 0) {
        try {
          const resolvedUsers = await resolveSlackUserAllowlist({
            token: resolveToken,
            entries: allowEntries
          });
          const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(
            resolvedUsers,
            {
              formatResolved: (entry) => {
                const note = entry.note ? ` (${entry.note})` : "";
                return `${entry.input}\u2192${entry.id}${note}`;
              }
            }
          );
          allowFrom = mergeAllowlist({ existing: allowFrom, additions });
          ctx.allowFrom = normalizeAllowList(allowFrom);
          summarizeMapping("slack users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(`slack user resolve failed; using config entries. ${String(err)}`);
        }
      }
      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        const userEntries = /* @__PURE__ */ new Set();
        for (const channel of Object.values(channelsConfig)) {
          addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
        }
        if (userEntries.size > 0) {
          try {
            const resolvedUsers = await resolveSlackUserAllowlist({
              token: resolveToken,
              entries: Array.from(userEntries)
            });
            const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(resolvedUsers);
            const nextChannels = patchAllowlistUsersInConfigEntries({
              entries: channelsConfig,
              resolvedMap
            });
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channel users", mapping, unresolved, runtime);
          } catch (err) {
            runtime.log?.(
              `slack channel user resolve failed; using config entries. ${String(err)}`
            );
          }
        }
      }
    })();
  }
  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void app.stop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  try {
    if (slackMode === "socket") {
      let reconnectAttempts = 0;
      while (!opts.abortSignal?.aborted) {
        try {
          await app.start();
          reconnectAttempts = 0;
          publishSlackConnectedStatus(opts.setStatus);
          runtime.log?.("slack socket mode connected");
        } catch (err) {
          if (isNonRecoverableSlackAuthError(err)) {
            runtime.error?.(
              `slack socket mode failed to start due to non-recoverable auth error \u2014 skipping channel (${formatUnknownError(err)})`
            );
            throw err;
          }
          reconnectAttempts += 1;
          if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) {
            throw err;
          }
          const delayMs2 = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          runtime.error?.(
            `slack socket mode failed to start. retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "\u221E"} in ${Math.round(delayMs2 / 1e3)}s (${formatUnknownError(err)})`
          );
          try {
            await sleepWithAbort(delayMs2, opts.abortSignal);
          } catch {
            break;
          }
          continue;
        }
        if (opts.abortSignal?.aborted) {
          break;
        }
        const disconnect = await waitForSlackSocketDisconnect(app, opts.abortSignal);
        if (opts.abortSignal?.aborted) {
          break;
        }
        publishSlackDisconnectedStatus(opts.setStatus, disconnect.error);
        if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
          runtime.error?.(
            `slack socket mode disconnected due to non-recoverable auth error \u2014 skipping channel (${formatUnknownError(disconnect.error)})`
          );
          throw disconnect.error instanceof Error ? disconnect.error : new Error(formatUnknownError(disconnect.error));
        }
        reconnectAttempts += 1;
        if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) {
          throw new Error(
            `Slack socket mode reconnect max attempts reached (${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) after ${disconnect.event}`
          );
        }
        const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
        runtime.error?.(
          `slack socket disconnected (${disconnect.event}). retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "\u221E"} in ${Math.round(delayMs / 1e3)}s${disconnect.error ? ` (${formatUnknownError(disconnect.error)})` : ""}`
        );
        await app.stop().catch(() => void 0);
        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch {
          break;
        }
      }
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
      if (!opts.abortSignal?.aborted) {
        await new Promise((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true
          });
        });
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterHttpHandler?.();
    await app.stop().catch(() => void 0);
  }
}
import { isNonRecoverableSlackAuthError as isNonRecoverableSlackAuthError2 } from "./reconnect-policy.js";
const __testing = {
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  resolveSlackRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  getSocketEmitter,
  waitForSlackSocketDisconnect
};
export {
  __testing,
  isNonRecoverableSlackAuthError2 as isNonRecoverableSlackAuthError,
  monitorSlackProvider
};
