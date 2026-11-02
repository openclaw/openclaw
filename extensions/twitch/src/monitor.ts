import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createChannelInboundEnvelopeBuilderAsync } from "openclaw/plugin-sdk/channel-inbound";
import {
  defineStableChannelIngressIdentity,
  type ChannelIngressContextBinding,
  type ChannelIngressIdentitySubjectInput,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateClientManager } from "./client-manager-registry.js";
import { getTwitchRuntime } from "./runtime.js";
import { sendMessageTwitchInternal } from "./send.js";
import { createTwitchIngress } from "./twitch-ingress.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

type TwitchPolicyKind = "open" | "allowFrom" | "role";

const twitchUserIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  entryIdPrefix: "twitch-user-entry",
});

const twitchRoleIdentity = defineStableChannelIngressIdentity({
  // Roles authorize the sender; only the native user ID identifies the participant.
  key: "sender-id",
  normalizeEntry: () => null,
  aliases: ["moderator", "owner", "vip", "subscriber"].map((role) => ({
    key: `role-${role}`,
    kind: "role",
    normalizeEntry: (entry) => (normalizeTwitchRole(entry) === role ? role : null),
    normalizeSubject: normalizeTwitchRole,
  })),
  resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`,
});

function resolveTwitchPolicyKind(account: TwitchAccountConfig): TwitchPolicyKind {
  if (account.allowFrom !== undefined) {
    return "allowFrom";
  }
  if (account.allowedRoles && account.allowedRoles.length > 0) {
    return "role";
  }
  return "open";
}

function twitchSubject(message: TwitchChatMessage): ChannelIngressIdentitySubjectInput {
  return {
    stableId: message.userId,
    aliases: {
      "role-moderator": message.isMod ? "moderator" : undefined,
      "role-owner": message.isOwner ? "owner" : undefined,
      "role-vip": message.isVip ? "vip" : undefined,
      "role-subscriber": message.isSub ? "subscriber" : undefined,
    },
  };
}

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  return role === "moderator" || role === "owner" || role === "vip" || role === "subscriber"
    ? role
    : null;
}

function mentionsBot(message: string, botUsername: string): boolean {
  const expected = normalizeLowercaseStringOrEmpty(botUsername);
  const mentionRegex = /@(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1] ? normalizeLowercaseStringOrEmpty(match[1]) : "";
    if (username === expected) {
      return true;
    }
  }

  return false;
}

export async function monitorTwitchProvider(options: {
  account: TwitchAccountConfig;
  accountId: string;
  channelRuntime: ReturnType<typeof getTwitchRuntime>["channel"];
  config: OpenClawConfig;
  runtime: {
    log?: (message: string) => void;
    error?: (message: string) => void;
  };
  abortSignal: AbortSignal;
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  const { account, accountId, channelRuntime, config, runtime, abortSignal, statusSink } = options;

  const core = getTwitchRuntime();
  let stopped = false;
  let stopTask: Promise<void> | undefined;

  const coreLogger = core.logging.getChildLogger({ module: "twitch" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    coreLogger.debug?.(message);
  };
  const logger = {
    info: (msg: string) => coreLogger.info(msg),
    warn: (msg: string) => coreLogger.warn(msg),
    error: (msg: string) => coreLogger.error(msg),
    debug: logVerboseMessage,
  };

  const clientManager = getOrCreateClientManager(accountId, logger, statusSink);

  await clientManager.getClient(account, config, accountId);

  const ingress = createTwitchIngress({
    accountId,
    runtime,
    deliver: async (message, turnAdoptionLifecycle) => {
      const botUsername = normalizeLowercaseStringOrEmpty(account.username);
      if (normalizeLowercaseStringOrEmpty(message.username) === botUsername) {
        return;
      }

      const checkAccess = (contextBinding?: ChannelIngressContextBinding) => {
        const policyKind = resolveTwitchPolicyKind(account);
        return core.channel.inbound.ingress
          .createResolver({
            channelId: "twitch",
            accountId,
            identity: policyKind === "role" ? twitchRoleIdentity : twitchUserIdentity,
          })
          .message({
            subject: twitchSubject(message),
            conversation: {
              kind: "group",
              id: message.channel,
            },
            contextBinding,
            event: { mayPair: false },
            mentionFacts: {
              canDetectMention: true,
              wasMentioned: mentionsBot(message.message, account.username),
            },
            dmPolicy: "open",
            groupPolicy: policyKind === "open" ? "open" : "allowlist",
            policy: {
              activation: {
                requireMention: account.requireMention ?? true,
                allowTextCommands: false,
                order: "before-sender",
              },
            },
            // Canonical wildcard input keeps admission and participant evidence aligned.
            groupAllowFrom:
              policyKind === "allowFrom"
                ? account.allowFrom
                : policyKind === "role"
                  ? account.allowedRoles?.map((role) => (role === "all" ? "*" : role))
                  : undefined,
          });
      };
      const access = await checkAccess();
      if (access.ingress.admission !== "dispatch") {
        return;
      }

      statusSink?.({ lastInboundAt: Date.now() });

      const cfg = config;
      const route = channelRuntime.routing.resolveAgentRoute({
        cfg,
        channel: "twitch",
        accountId,
        peer: {
          kind: "group",
          id: message.channel,
        },
      });
      const exactAccess = await checkAccess({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: message.id,
        inboundEventKind: "user_request",
      });
      if (exactAccess.ingress.admission !== "dispatch") {
        return;
      }

      await channelRuntime.inbound.run({
        channel: "twitch",
        accountId,
        raw: message,
        turnAdoptionLifecycle,
        adapter: {
          ingest: (incoming) => ({
            id: incoming.id,
            timestamp: incoming.timestamp,
            rawText: incoming.message,
            textForAgent: incoming.message,
            textForCommands: incoming.message,
            raw: incoming,
          }),
          resolveTurn: async (input) => {
            const senderId = message.userId ?? message.username;
            const fromLabel = message.displayName ?? message.username;
            const body = (await createChannelInboundEnvelopeBuilderAsync({ cfg, route }))({
              channel: "Twitch",
              from: fromLabel,
              timestamp: input.timestamp,
              body: input.rawText,
            });
            const ctxPayload = channelRuntime.inbound.buildContext({
              channelIngress: exactAccess,
              channel: "twitch",
              accountId,
              messageId: input.id,
              timestamp: input.timestamp,
              from: `twitch:user:${senderId}`,
              sender: {
                id: senderId,
                name: fromLabel,
                username: message.username,
              },
              conversation: {
                kind: "group",
                id: message.channel,
                label: message.channel,
              },
              route: {
                agentId: route.agentId,
                dmScope: route.dmScope,
                accountId: route.accountId,
                routeSessionKey: route.sessionKey,
              },
              reply: {
                to: `twitch:channel:${message.channel}`,
              },
              message: {
                body,
                rawBody: input.rawText,
                bodyForAgent: input.textForAgent,
                commandBody: input.textForCommands,
              },
            });
            return {
              cfg,
              channel: "twitch",
              accountId,
              route: {
                agentId: route.agentId,
                dmScope: route.dmScope,
                sessionKey: route.sessionKey,
              },
              ctxPayload,
              delivery: {
                durable: () => ({
                  to: `twitch:channel:${message.channel}`,
                }),
                deliver: async (payload) => {
                  try {
                    const replyClientManager = getOrCreateClientManager(accountId, {
                      info: (msg) => runtime.log?.(msg),
                      warn: (msg) => runtime.log?.(msg),
                      error: (msg) => runtime.error?.(msg),
                      debug: (msg) => runtime.log?.(msg),
                    });

                    const result = await sendMessageTwitchInternal({
                      channel: message.channel,
                      text: [payload.text, ...resolveOutboundMediaUrls(payload)]
                        .filter(Boolean)
                        .join(" "),
                      cfg: config,
                      account,
                      accountId,
                      clientManager: replyClientManager,
                    });
                    if (result.outcome === "not_sent") {
                      runtime.error?.(`No text to send in reply payload`);
                      return { visibleReplySent: false };
                    }
                    return { visibleReplySent: true };
                  } catch (err) {
                    runtime.error?.(`Failed to send reply: ${String(err)}`);
                    return { visibleReplySent: false };
                  }
                },
                onDelivered: (_payload, _info, result) => {
                  if (result?.visibleReplySent !== false) {
                    statusSink?.({ lastOutboundAt: Date.now() });
                  }
                },
                onError: (err, info) => {
                  runtime.error?.(`Twitch ${info.kind} reply failed: ${String(err)}`);
                },
              },
              replyPipeline: {},
              record: {
                onRecordError: (err) => {
                  runtime.error?.(`Failed updating session meta: ${String(err)}`);
                },
              },
            };
          },
        },
      });
    },
  });
  ingress.start();

  const unregisterHandler = clientManager.onMessage((message) => {
    if (stopped) {
      return;
    }

    void ingress.accept(message).catch((err: unknown) => {
      runtime.error?.(`Message durable admission failed: ${String(err)}`);
    });
  });

  const stop = (): Promise<void> => {
    stopTask ??= (async () => {
      stopped = true;
      unregisterHandler();
      await ingress.stop();
    })();
    return stopTask;
  };

  abortSignal.addEventListener(
    "abort",
    () => {
      void stop().catch((error: unknown) => {
        runtime.error?.(`Twitch ingress stop failed: ${String(error)}`);
      });
    },
    { once: true },
  );

  return { stop };
}
