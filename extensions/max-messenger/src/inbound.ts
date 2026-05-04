/**
 * Inbound dispatch for the MAX channel (Phase 1B.3 — agent reply path).
 *
 * Mirrors the nextcloud-talk dispatcher (`extensions/nextcloud-talk/src/inbound.ts`)
 * but trimmed for MAX's surface today:
 *
 *   - MAX events carry chat type via `recipient.chat_type`, so no live
 *     room-info lookup is needed (DM === `dialog`, anything else === group).
 *   - No per-room config in the schema yet (Phase 3 territory). Group routing
 *     uses the channel-wide `groupAllowFrom` allowlist only.
 *   - Mention regexes / control-command gating deferred to Phase 3 — Phase 1B
 *     groups are routed strictly by allowlist.
 *
 * The actual agent reply pipeline (`dispatchInboundReplyWithBase`) is the
 * same SDK seam every other channel uses; the deliver callback wraps our
 * existing `sendMaxText` so chunked agent replies go out via the same
 * `polling-http` wrapper the supervisor already trusts.
 */

import {
  GROUP_POLICY_BLOCKED_LABEL,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithCommandGate,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";
import { getMaxRuntime } from "./runtime.js";
import { sendMaxText } from "./send.js";
import type { CoreConfig, MaxInboundMessage, ResolvedMaxAccount } from "./types.js";

export { normalizeMaxInboundMessage } from "./normalize.js";

const CHANNEL_ID = "max-messenger" as const;

function normalizeAllowlist(allow: ReadonlyArray<string | number> | undefined): string[] {
  if (!allow) {
    return [];
  }
  const out: string[] = [];
  for (const entry of allow) {
    const str = typeof entry === "string" ? entry.trim() : String(entry).trim();
    if (str) {
      out.push(str);
    }
  }
  return out;
}

function isSenderAllowed(allow: ReadonlyArray<string | number>, senderId: string): boolean {
  if (allow.length === 0) {
    return false;
  }
  for (const entry of allow) {
    const str = typeof entry === "string" ? entry.trim() : String(entry).trim();
    if (str === "*" || str === senderId) {
      return true;
    }
  }
  return false;
}

async function deliverMaxReply(params: {
  cfg: CoreConfig;
  payload: OutboundReplyPayload;
  chatId: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { cfg, payload, chatId, accountId, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text, replyToId }) => {
      await sendMaxText({
        cfg,
        to: chatId,
        accountId,
        text,
        replyToId: replyToId ?? null,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export type HandleMaxInboundParams = {
  message: MaxInboundMessage;
  account: ResolvedMaxAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function handleMaxInbound(params: HandleMaxInboundParams): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getMaxRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  const isGroup = message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const chatId = message.chatId;
  const chatTitle = message.chatTitle;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.["max-messenger"] ??
          undefined) !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "max-messenger",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (msg) => runtime.log?.(msg),
  });

  const configAllowFrom = normalizeAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeAllowlist(storeAllowFrom);

  // No control-command parsing / mention regex in Phase 1B.3 — both deferred
  // to Phase 3 per plan §6. Pass `allowTextCommands: false` so the access
  // gate stays purely allowlist-driven.
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allow) => isSenderAllowed(allow, senderId),
    command: {
      useAccessGroups: false,
      allowTextCommands: false,
      hasControlCommand: false,
    },
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`max-messenger: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    if (!isSenderAllowed(effectiveGroupAllowFrom, senderId)) {
      runtime.log?.(`max-messenger: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your MAX user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            await sendMaxText({
              cfg: config,
              to: chatId,
              accountId: account.accountId,
              text,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`max-messenger: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`max-messenger: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (msg) => runtime.log?.(msg),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? chatId : senderId,
    },
  });

  const fromLabel = isGroup ? `chat:${chatTitle || chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "MAX",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `max-messenger:chat:${chatId}` : `max-messenger:${senderId}`,
    To: `max-messenger:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? chatTitle || chatId : undefined,
    GroupSystemPrompt: undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `max-messenger:${chatId}`,
    CommandAuthorized: commandAuthorized,
  });

  await dispatchInboundReplyWithBase({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      await deliverMaxReply({
        cfg: config,
        payload,
        chatId,
        accountId: account.accountId,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`max-messenger: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`max-messenger ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
