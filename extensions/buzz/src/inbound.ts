import { normalizeURL } from "nostr-tools/utils";
import {
  buildChannelInboundEventContext,
  logInboundDrop,
  recordDroppedChannelInboundHistory,
  createChannelInboundEnvelopeBuilderAsync,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  buildHistoryContext,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BuzzBus } from "./buzz-bus.js";
import type { BuzzConfigInput } from "./config-schema.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  formatBuzzMessageForAgent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { getBuzzRuntime } from "./runtime.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import type { ResolvedBuzzAccount } from "./types.js";

const log = createSubsystemLogger("buzz/inbound");
const HISTORY_ENTRY_BYTES = 512;
const HISTORY_CONTEXT_BYTES = 1_024;

export async function handleBuzzInbound(params: {
  account: ResolvedBuzzAccount;
  cfg: OpenClawConfig;
  bus: BuzzBus;
  message: BuzzInboundMessage;
  signal: AbortSignal;
  assertCurrent: () => void;
  historyMap: Map<string, HistoryEntry[]>;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const runtime = getBuzzRuntime();
  const { account, cfg, bus, message, signal, historyMap } = params;
  const channelId = parseBuzzTarget(message.channelId);
  const target = buildBuzzTarget(channelId);
  const textForAgent = formatBuzzMessageForAgent(message);
  const route = resolveAgentRoute({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
    peer: { kind: "group", id: target },
  });
  const supportsTextInterpretation = message.kind !== BUZZ_DIFF_MESSAGE_KIND;
  const textMention =
    supportsTextInterpretation &&
    runtime.channel.mentions.matchesMentionPatterns(
      message.text,
      runtime.channel.mentions.buildMentionRegexes(cfg, route.agentId),
    );
  const wasMentioned = message.mentionedPubkeys.includes(bus.publicKey) || textMention;
  const shouldComputeCommandAuthorized =
    supportsTextInterpretation &&
    runtime.channel.commands.shouldComputeCommandAuthorized(message.text, cfg);
  const hasControlCommand =
    shouldComputeCommandAuthorized && runtime.channel.text.hasControlCommand(message.text, cfg);
  const groupConfig = account.config.groups?.[channelId];
  const requireMention = groupConfig?.requireMention ?? true;
  const isBotOwnedThread =
    message.threadId &&
    !wasMentioned &&
    groupConfig?.requireMentionInBotThreads !== undefined &&
    groupConfig.requireMentionInBotThreads !== requireMention
      ? await bus.isBotOwnedThread({ channelId, threadId: message.threadId })
      : false;
  params.assertCurrent();
  const mentionPolicy = resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads: groupConfig?.requireMentionInBotThreads,
    requireMention,
  });
  const access = await runtime.channel.inbound.ingress.resolveStable({
    channelId: "buzz",
    accountId: account.accountId,
    identity: { key: "buzz-pubkey", entryIdPrefix: "buzz-entry" },
    subject: { stableId: message.senderPubkey },
    conversation: {
      kind: "group",
      id: channelId,
      threadId: message.threadId,
    },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      nativeChannelId: channelId,
      messageId: message.id,
      inboundEventKind: "user_request",
    },
    mentionFacts: { canDetectMention: true, wasMentioned },
    groupPolicy: groupConfig?.groupPolicy ?? account.config.groupPolicy,
    groupAllowFrom: groupConfig?.groupAllowFrom ?? account.config.groupAllowFrom,
    policy: {
      activation: {
        requireMention: mentionPolicy.requireMention,
        allowTextCommands: true,
      },
    },
    command: shouldComputeCommandAuthorized
      ? {
          allowTextCommands: true,
          hasControlCommand,
        }
      : undefined,
  });
  // Admission awaits policy; only the transport owner can confirm membership is still current.
  params.assertCurrent();
  const historyKey = JSON.stringify([channelId, message.threadId ?? null]);
  const historyLimit = account.config.historyLimit ?? 0;
  if (access.ingress.admission !== "dispatch") {
    if (access.ingress.reasonCode === "activation_skipped") {
      // SAFETY: Buzz's manifest schema validates this plugin-owned channel section before startup.
      const buzzConfig = cfg.channels?.buzz as BuzzConfigInput | undefined;
      const groupsPath = buzzConfig?.accounts?.[account.accountId]
        ? `channels.buzz.accounts[${JSON.stringify(account.accountId)}].groups`
        : "channels.buzz.groups";
      logInboundDrop({
        log: log.info,
        channel: "buzz",
        reason: "no mention",
        target: channelId,
        onceKey: JSON.stringify([account.accountId, channelId]),
        hint: `Mention patterns can be derived from the agent identity name. Set ${groupsPath}[${JSON.stringify(channelId)}].requireMention=false to process messages without a mention.`,
      });
      await recordDroppedChannelInboundHistory({
        input: {
          id: message.id,
          timestamp: message.createdAt * 1_000,
          rawText: truncateUtf8Prefix(textForAgent, HISTORY_ENTRY_BYTES),
        },
        preflight: {
          admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
          message: { senderLabel: message.senderPubkey },
          history: {
            historyMap,
            key: historyKey,
            limit: historyLimit,
            shouldRecord: () =>
              !signal.aborted && bus.directory.isMember(channelId, message.senderPubkey),
          },
        },
      });
    }
    return;
  }

  const pendingHistory =
    createChannelHistoryWindow({ historyMap }).buildInboundHistory({
      historyKey,
      limit: historyLimit,
    }) ?? [];
  const historyEntries: HistoryEntry[] = [];
  let historyText = "";
  // Keep the newest complete entries; count alone cannot bound model-visible context.
  for (const entry of pendingHistory.toReversed()) {
    if (!bus.directory.isMember(channelId, entry.sender)) {
      continue;
    }
    const label = truncateUtf8Prefix(bus.directory.resolveSenderName(entry.sender), 128);
    const nextText = [`${label}: ${entry.body}`, historyText].filter(Boolean).join("\n");
    if (
      Buffer.byteLength(buildHistoryContext({ historyText: nextText, currentMessage: "" })) >
      HISTORY_CONTEXT_BYTES
    ) {
      break;
    }
    historyEntries.unshift(entry);
    historyText = nextText;
  }
  if (historyEntries.length) {
    historyMap.set(historyKey, historyEntries);
  } else {
    historyMap.delete(historyKey);
  }
  const consumedIds = new Set(historyEntries.map((entry) => entry.messageId));
  const bodyForAgent = buildHistoryContext({ historyText, currentMessage: textForAgent });

  const senderName = bus.directory.resolveSenderName(message.senderPubkey);
  const roomName = bus.directory.resolveRoomName(channelId);
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg, route });
  const body = buildEnvelope({
    channel: "Buzz",
    from: senderName,
    timestamp: new Date(message.createdAt * 1000),
    body: textForAgent,
  });
  const ctxPayload = (params.buildContext ?? buildChannelInboundEventContext)({
    channelIngress: access,
    channel: "buzz",
    accountId: route.accountId ?? account.accountId,
    messageId: message.id,
    messageIdFull: message.id,
    timestamp: message.createdAt * 1000,
    from: target,
    sender: { id: message.senderPubkey, name: senderName },
    conversation: {
      kind: "group",
      id: channelId,
      label: roomName,
      threadId: message.threadId,
      nativeChannelId: channelId,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: message.id,
      messageThreadId: message.threadId,
      threadParentId: message.threadId ? channelId : undefined,
    },
    message: {
      body,
      bodyForAgent,
      rawBody: message.text,
      commandBody: supportsTextInterpretation ? message.text : "",
    },
    access: {
      commands: { authorized: access.commandAccess.authorized },
      mentions: { canDetectMention: true, wasMentioned },
    },
    extra: {
      GroupSubject: roomName,
      BuzzEventKind: message.kind,
    },
  });
  const replyTarget = {
    channelId,
    threadId: account.config.replyToMode === "off" ? undefined : message.threadId,
    replyToId: account.config.replyToMode === "off" ? undefined : (message.threadId ?? message.id),
  };

  const result = await runtime.channel.inbound.dispatch({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      sessionKey: route.sessionKey,
    },
    ctxPayload,
    botLoopProtection: bus.directory.isBotMember(channelId, message.senderPubkey)
      ? {
          // Reciprocal accounts share the relay/room pair budget. Threads and
          // sender timestamps must not let a bot reset or evade that budget.
          scopeId: `buzz:${normalizeURL(account.relayUrl)}`,
          conversationId: channelId,
          senderId: message.senderPubkey,
          receiverId: bus.publicKey,
          eventId: message.id,
          defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
        }
      : undefined,
    log: (event) => {
      if (event.reason === "bot-loop-protection") {
        log.warn(`[${account.accountId}] Buzz bot-pair loop suppressed in ${channelId}`);
      }
    },
    delivery: {
      deliver: async (payload) => {
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }
        await bus.sendText({ ...replyTarget, text });
      },
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
    replyOptions: {
      abortSignal: signal,
    },
    replyPipeline: {
      typing: {
        start: async () => {
          await bus.sendTyping(replyTarget);
        },
        keepaliveIntervalMs: 3_000,
        onStartError: (error: unknown) => {
          log.error(`[${account.accountId}] Buzz typing failed for ${channelId}: ${String(error)}`);
        },
      },
    },
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`Buzz session record failed: ${String(error)}`);
      },
    },
  });
  if (result.dispatched) {
    // A reply may finish after another passive message arrives. Consume only this snapshot.
    const remaining = historyMap
      .get(historyKey)
      ?.filter((entry) => !consumedIds.has(entry.messageId));
    if (remaining?.length) {
      historyMap.set(historyKey, remaining);
    } else {
      historyMap.delete(historyKey);
    }
  }
}
