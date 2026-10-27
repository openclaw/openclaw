import {
  logInboundDrop,
  createChannelInboundEnvelopeBuilderAsync,
} from "openclaw/plugin-sdk/channel-inbound";
import { channelIngressRoutes } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient, type IrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { createIrcIngressSubject, ircIngressIdentity } from "./ingress-identity.js";
import {
  createIrcIngressMonitor,
  type IrcIngressLifecycle,
  type IrcIngressMonitor,
} from "./irc-ingress.js";
import { normalizeIrcAllowEntry } from "./normalize.js";
import { sanitizeIrcAssistantText } from "./outbound-base.js";
import { resolveIrcGroupMatch, resolveIrcGroupRequireMention } from "./policy.js";
import { createIrcReconnectBackoff } from "./reconnect-backoff.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_ID = "irc" as const;
type IrcGroupPolicy = "open" | "allowlist" | "disabled";

// IRC nicknames permit punctuation, so ASCII word boundaries lose valid leading/trailing chars.
const IRC_NICK_CHARACTER = String.raw`[A-Za-z0-9_\-\[\]\\\x60^{}|~]`;
const IRC_RFC1459_CASE_EQUIVALENTS = new Map([
  ["[", "{"],
  ["{", "["],
  ["]", "}"],
  ["}", "]"],
  ["\\", "|"],
  ["|", "\\"],
  ["^", "~"],
  ["~", "^"],
]);

function buildIrcNickMentionPattern(value: string): string {
  return Array.from(value, (character) => {
    const equivalent = IRC_RFC1459_CASE_EQUIVALENTS.get(character);
    return equivalent
      ? `[${escapeRegExp(character)}${escapeRegExp(equivalent)}]`
      : escapeRegExp(character);
  }).join("");
}

function hasEntries(entries: Array<string | number> | undefined): boolean {
  return normalizeStringEntries(entries).some((entry) => normalizeIrcAllowEntry(entry));
}

type IrcMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  ingressQueue?: NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
};

export async function monitorIrcProvider(
  opts: IrcMonitorOptions,
): Promise<{ stop: () => Promise<void> }> {
  const core = getIrcRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "irc",
    accountId: account.accountId,
  });

  let client: IrcClient | null = null;
  let activeConnectionEpoch: string | null = null;
  let ingressPause: Promise<void> = Promise.resolve();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const reconnectBackoff = createIrcReconnectBackoff();
  let stopped = false;
  const monitorAbort = new AbortController();
  const abortSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, monitorAbort.signal])
    : monitorAbort.signal;

  const ingress: IrcIngressMonitor = createIrcIngressMonitor({
    accountId: account.accountId,
    runtime,
    ...(opts.ingressQueue ? { queue: opts.ingressQueue } : {}),
    dispatch: async (
      message,
      turnAdoptionLifecycle: IrcIngressLifecycle,
      context: { connectedNick: string; connectionEpoch: string },
    ) => {
      const activeClient = client;
      if (!activeClient || stopped || abortSignal.aborted) {
        return {
          kind: "failed-retryable",
          error: new Error("IRC transport disconnected before ingress dispatch."),
        };
      }
      if (
        normalizeLowercaseStringOrEmpty(message.senderNick) ===
        normalizeLowercaseStringOrEmpty(context.connectedNick)
      ) {
        return { kind: "completed" };
      }
      // IRC nicknames can change owners between connections. Channel replay is
      // safe, but a stale DM recipient cannot be revalidated after reconnect.
      if (!message.isGroup && context.connectionEpoch !== activeConnectionEpoch) {
        logger.warn?.(
          `[${account.accountId}] dropping replayed IRC DM after the connection changed`,
        );
        return { kind: "completed" };
      }
      const deliverReply = async (target: string, payload: OutboundReplyPayload) => {
        await deliverFormattedTextWithAttachments({
          payload: { ...payload, text: sanitizeIrcAssistantText(payload.text ?? "") },
          send: async ({ text }) => {
            const replyClient = client;
            if (!replyClient || !replyClient.isReady() || stopped || abortSignal.aborted) {
              throw new Error("IRC transport disconnected before reply send.");
            }
            if (!message.isGroup && context.connectionEpoch !== activeConnectionEpoch) {
              throw new Error("IRC connection changed before private reply send.");
            }
            await replyClient.sendPrivmsg(target, text);
            opts.statusSink?.({ lastOutboundAt: Date.now() });
            core.channel.activity.record({
              channel: "irc",
              accountId: account.accountId,
              direction: "outbound",
            });
          },
        });
      };
      const pairing = createChannelPairingController({
        core,
        channel: CHANNEL_ID,
        accountId: account.accountId,
      });

      const rawBody = message.text?.trim() ?? "";
      if (!rawBody) {
        return { kind: "completed" };
      }
      if (turnAdoptionLifecycle?.abortSignal.aborted) {
        return {
          kind: "failed-retryable",
          error: turnAdoptionLifecycle.abortSignal.reason,
        };
      }

      opts.statusSink?.({ lastInboundAt: message.timestamp });

      const senderDisplay = message.senderHost
        ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}`
        : message.senderNick;
      const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

      const dmPolicy = account.config.dmPolicy ?? "pairing";
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy, providerMissingFallbackApplied } =
        resolveAllowlistProviderRuntimeGroupPolicy({
          providerConfigPresent: cfg.channels?.irc !== undefined,
          groupPolicy: account.config.groupPolicy,
          defaultGroupPolicy,
        });
      warnMissingProviderGroupPolicyFallbackOnce({
        providerMissingFallbackApplied,
        providerKey: "irc",
        accountId: account.accountId,
        blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
        log: (messageLocal) => runtime.log?.(messageLocal),
      });

      const groupMatch = resolveIrcGroupMatch({
        groups: account.config.groups,
        target: message.target,
      });

      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: CHANNEL_ID,
      });
      const hasControlCommand = core.channel.text.hasControlCommand(rawBody, cfg);
      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
      const mentionNick = context.connectedNick.trim() || account.nick;
      const explicitMentionRegex = mentionNick
        ? new RegExp(
            `(?<!${IRC_NICK_CHARACTER})${buildIrcNickMentionPattern(mentionNick)}(?!${IRC_NICK_CHARACTER})[:,]?`,
            "i",
          )
        : null;
      const wasMentioned =
        core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) ||
        (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
      const requireMention = message.isGroup
        ? resolveIrcGroupRequireMention({ groups: account.config.groups, target: message.target })
        : false;
      const routeGroupAllowFrom = normalizeStringEntries(
        groupMatch.groupConfig?.allowFrom?.length
          ? groupMatch.groupConfig.allowFrom
          : groupMatch.wildcardConfig?.allowFrom,
      );
      const accessGroupPolicy: IrcGroupPolicy =
        groupPolicy === "open" &&
        (hasEntries(account.config.groupAllowFrom) || hasEntries(routeGroupAllowFrom))
          ? "allowlist"
          : groupPolicy;
      const channelTarget =
        message.target.startsWith("#") || message.target.startsWith("&")
          ? message.target
          : `#${message.target}`;
      const peerId = message.isGroup ? channelTarget : message.senderNick;
      const route = resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: {
          kind: message.isGroup ? "group" : "direct",
          id: peerId,
        },
      });
      const access = await core.channel.inbound.ingress
        .createResolver({
          channelId: CHANNEL_ID,
          accountId: account.accountId,
          identity: ircIngressIdentity,
          cfg,
          readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
        })
        .message({
          subject: createIrcIngressSubject(message),
          conversation: {
            kind: message.isGroup ? "group" : "direct",
            id: message.target,
          },
          contextBinding: {
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            ...(message.messageId ? { messageId: message.messageId } : {}),
            inboundEventKind: "user_request",
          },
          route: message.isGroup
            ? channelIngressRoutes(
                groupPolicy === "allowlist" && {
                  id: "irc:channel",
                  allowed: groupMatch.hasConfiguredGroups && groupMatch.allowed,
                  precedence: 0,
                  matchId: "irc-channel",
                  blockReason: "channel_not_allowlisted",
                },
                (groupMatch.groupConfig?.enabled === false ||
                  groupMatch.wildcardConfig?.enabled === false) && {
                  id: "irc:channel-enabled",
                  enabled: false,
                  precedence: 10,
                  blockReason: "channel_disabled",
                },
                hasEntries(routeGroupAllowFrom) && {
                  id: "irc:channel-sender",
                  precedence: 20,
                  senderPolicy: "replace",
                  senderAllowFrom: routeGroupAllowFrom,
                },
              )
            : [],
          mentionFacts: message.isGroup
            ? {
                canDetectMention: true,
                wasMentioned,
                hasAnyMention: wasMentioned,
              }
            : undefined,
          dmPolicy,
          groupPolicy: accessGroupPolicy,
          policy: {
            groupAllowFromFallbackToAllowFrom: false,
            mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
            activation: {
              requireMention: message.isGroup && requireMention,
              allowTextCommands,
            },
          },
          allowFrom: account.config.allowFrom,
          groupAllowFrom: account.config.groupAllowFrom,
          command: {
            allowTextCommands,
            hasControlCommand,
          },
        });
      const commandAuthorized = access.commandAccess.authorized;

      if (access.ingress.admission === "pairing-required") {
        await pairing.issueChallenge({
          senderId: normalizeLowercaseStringOrEmpty(senderDisplay),
          senderIdLine: `Your IRC id: ${senderDisplay}`,
          meta: { name: message.senderNick || undefined },
          sendPairingReply: async (text) => {
            await deliverReply(message.senderNick, { text });
          },
          onReplyError: (err) => {
            runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
          },
        });
        runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return { kind: "completed" };
      }
      if (access.ingress.admission === "skip") {
        runtime.log?.(`irc: drop channel ${message.target} (missing-mention)`);
        return { kind: "completed" };
      }
      if (access.ingress.admission !== "dispatch") {
        if (
          message.isGroup &&
          access.ingress.decisiveGateId === "command" &&
          access.commandAccess.shouldBlockControlCommand
        ) {
          logInboundDrop({
            log: (line) => runtime.log?.(line),
            channel: CHANNEL_ID,
            reason: "control command (unauthorized)",
            target: senderDisplay,
          });
          return { kind: "completed" };
        }
        if (message.isGroup) {
          if (access.routeAccess.reason === "channel_not_allowlisted") {
            runtime.log?.(`irc: drop channel ${message.target} (not allowlisted)`);
          } else if (access.routeAccess.reason === "channel_disabled") {
            runtime.log?.(`irc: drop channel ${message.target} (disabled)`);
          } else {
            runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
          }
        } else {
          runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        }
        return { kind: "completed" };
      }

      if (turnAdoptionLifecycle?.abortSignal.aborted) {
        return {
          kind: "failed-retryable",
          error: turnAdoptionLifecycle.abortSignal.reason,
        };
      }

      const fromLabel = message.isGroup ? message.target : senderDisplay;
      const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg, route });
      const body = buildEnvelope({
        channel: "IRC",
        from: fromLabel,
        timestamp: message.timestamp,
        body: rawBody,
      });

      const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);
      const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);

      const ctxPayload = core.channel.inbound.buildContext({
        channelIngress: access,
        channel: CHANNEL_ID,
        accountId: route.accountId,
        messageId: message.messageId,
        timestamp: message.timestamp,
        from: message.isGroup ? `channel:${channelTarget}` : `irc:${senderDisplay}`,
        sender: { id: senderDisplay, name: message.senderNick || undefined },
        conversation: {
          kind: message.isGroup ? "group" : "direct",
          id: peerId,
          label: fromLabel,
        },
        route: {
          agentId: route.agentId,
          dmScope: route.dmScope,
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
        },
        reply: {
          to: message.isGroup ? `channel:${channelTarget}` : `irc:${peerId}`,
          originatingTo: message.isGroup ? `channel:${channelTarget}` : `irc:${peerId}`,
        },
        message: { body, bodyForAgent: rawBody, rawBody, commandBody: rawBody },
        access: {
          commands: { authorized: commandAuthorized },
          mentions: { canDetectMention: message.isGroup, wasMentioned },
        },
        extra: {
          GroupSubject: message.isGroup ? message.target : undefined,
          GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
        },
      });

      await core.channel.inbound.dispatch({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        ctxPayload,
        delivery: {
          deliver: async (payload) => {
            await deliverReply(peerId, payload);
          },
          onError: (err, info) => {
            runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyPipeline: {},
        replyOptions: {
          ...bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle),
          skillFilter: groupMatch.groupConfig?.skills,
          disableBlockStreaming:
            typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
        },
        record: {
          onRecordError: (err) => {
            runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
          },
        },
      });
      return undefined;
    },
  });

  function scheduleReconnect(): number | undefined {
    if (stopped || abortSignal.aborted || reconnectTimer) {
      return undefined;
    }
    opts.statusSink?.({ connected: false, lifecycle: "recovering" });
    const delayMs = reconnectBackoff.nextDelayMs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error: unknown) => {
        if (stopped || abortSignal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${account.accountId}] IRC reconnect failed: ${message}`);
        opts.statusSink?.({ lastError: message });
        scheduleReconnect();
      });
    }, delayMs);
    return delayMs;
  }

  async function connect() {
    if (stopped || abortSignal.aborted) {
      return;
    }
    const ingressConnection = ingress.openConnection();
    const nextClient = await connectIrcClient(
      buildIrcConnectOptions(account, {
        channels: account.config.channels,
        abortSignal,
        onNotice: (text, target) => {
          if (core.logging.shouldLogVerbose()) {
            logger.debug?.(`[${account.accountId}] notice ${target ?? ""} len=${text.length}`);
          }
        },
        onError: (error) => {
          logger.error(`[${account.accountId}] IRC error: ${error.message}`);
        },
        onDisconnect: () => {
          if (stopped || abortSignal.aborted) {
            return;
          }
          ingressPause = ingress.pause();
          if (activeConnectionEpoch === ingressConnection.connectionEpoch) {
            activeConnectionEpoch = null;
          }
          client = null;
          opts.statusSink?.({ lastDisconnect: { at: Date.now() } });
          const delayMs = scheduleReconnect();
          if (delayMs !== undefined) {
            logger.warn?.(
              `[${account.accountId}] IRC connection closed; reconnecting in ${delayMs}ms`,
            );
          }
        },
        onPrivmsg: async (event) => {
          await ingressConnection.accept(event.rawLine, event.connectedNick);
          if (
            normalizeLowercaseStringOrEmpty(event.senderNick) ===
            normalizeLowercaseStringOrEmpty(event.connectedNick)
          ) {
            return;
          }
          core.channel.activity.record({
            channel: "irc",
            accountId: account.accountId,
            direction: "inbound",
            at: Date.now(),
          });
        },
      }),
    );
    if (stopped || abortSignal.aborted) {
      nextClient.quit("shutdown");
      return;
    }
    client = nextClient;
    activeConnectionEpoch = ingressConnection.connectionEpoch;
    await ingressPause;
    if (client !== nextClient || !nextClient.isReady()) {
      if (activeConnectionEpoch === ingressConnection.connectionEpoch) {
        activeConnectionEpoch = null;
      }
      return;
    }
    ingress.start();
    reconnectBackoff.markConnected();
    opts.statusSink?.(channelReadyPatch());

    logger.info(
      `[${account.accountId}] connected to ${account.host}:${account.port}${account.tls ? " (tls)" : ""} as ${nextClient.nick}`,
    );
  }

  try {
    await connect();
  } catch (error) {
    await ingress.stop();
    throw error;
  }

  let stopTask: Promise<void> | undefined;
  return {
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        if (!abortSignal.aborted) {
          monitorAbort.abort();
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        client?.quit("shutdown");
        client = null;
        activeConnectionEpoch = null;
        await ingress.stop();
      })();
      return stopTask;
    },
  };
}
