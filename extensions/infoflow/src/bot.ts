import type {
  InfoflowChatType,
  InfoflowMessageEvent,
  HandleInfoflowMessageParams,
  HandlePrivateChatParams,
  HandleGroupChatParams,
} from "./types.js";
import { resolveInfoflowAccount } from "./channel.js";
import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";
import { getInfoflowRuntime } from "./runtime.js";

// Re-export types for external consumers
export type { InfoflowChatType, InfoflowMessageEvent } from "./types.js";

// ---------------------------------------------------------------------------
// @mention detection types and helpers
// ---------------------------------------------------------------------------

/**
 * Body item in Infoflow group message, supporting TEXT, AT, LINK types.
 */
type InfoflowBodyItem = {
  type?: string;
  content?: string;
  label?: string;
  /** Robot ID when type is AT */
  robotid?: number;
  /** Robot/user name when type is AT */
  name?: string;
};

/**
 * Check if the bot was @mentioned in the message body.
 * Matches configured robotName against AT elements (case-insensitive).
 */
function checkBotMentioned(bodyItems: InfoflowBodyItem[], robotName?: string): boolean {
  if (!robotName) {
    return false; // Cannot detect mentions without configured robotName
  }
  const normalizedRobotName = robotName.toLowerCase();
  for (const item of bodyItems) {
    if (item.type === "AT" && item.name) {
      if (item.name.toLowerCase() === normalizedRobotName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Handles an incoming private chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handlePrivateChatMessage(params: HandlePrivateChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;
  const core = getInfoflowRuntime();
  const verbose = core.logging.shouldLogVerbose();

  if (verbose) {
    console.log("[infoflow] Received private chat message:", JSON.stringify(msgData, null, 2));
  }

  // Extract sender and content from msgData (flexible field names)
  const fromuser = String(msgData.FromUserId ?? msgData.fromuserid ?? msgData.from ?? "");
  const mes = String(msgData.Content ?? msgData.content ?? msgData.text ?? msgData.mes ?? "");

  // Extract sender name (FromUserName is more human-readable than FromUserId)
  const senderName = String(msgData.FromUserName ?? msgData.username ?? fromuser);

  // Extract message ID for dedup tracking
  const messageId = msgData.MsgId ?? msgData.msgid ?? msgData.messageid;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  // Extract timestamp (CreateTime is in seconds, convert to milliseconds)
  const createTime = msgData.CreateTime ?? msgData.createtime;
  const timestamp = createTime != null ? Number(createTime) * 1000 : Date.now();

  if (verbose) {
    console.log(
      `[infoflow] Private chat extracted: fromuser=${fromuser}, senderName=${senderName}, mes=${mes.slice(0, 50)}...`,
    );
  }

  if (!fromuser || !mes.trim()) {
    if (verbose) {
      console.log(`[infoflow] Private chat skipped: missing fromuser or empty message`);
    }
    return;
  }

  // Delegate to the common message handler (private chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      chatType: "direct",
      senderName,
      messageId: messageIdStr,
      timestamp,
    },
    accountId,
    statusSink,
  });
}

/**
 * Handles an incoming group chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handleGroupChatMessage(params: HandleGroupChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;
  const core = getInfoflowRuntime();
  const verbose = core.logging.shouldLogVerbose();

  if (verbose) {
    console.log("[infoflow] Received group chat message:", JSON.stringify(msgData, null, 2));
  }

  // Extract sender from nested structure or flat fields
  const header = (msgData.message as Record<string, unknown>)?.header as
    | Record<string, unknown>
    | undefined;
  const fromuser = String(header?.fromuserid ?? msgData.fromuserid ?? msgData.from ?? "");

  // Extract message ID (priority: header.messageid > header.msgid > MsgId)
  const messageId = header?.messageid ?? header?.msgid ?? msgData.MsgId;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  const rawGroupId = msgData.groupid ?? header?.groupid;
  const groupid =
    typeof rawGroupId === "number" ? rawGroupId : rawGroupId ? Number(rawGroupId) : undefined;

  // Extract timestamp (time is in milliseconds)
  const rawTime = msgData.time ?? header?.servertime;
  const timestamp = rawTime != null ? Number(rawTime) : Date.now();

  if (verbose) {
    console.log(`[infoflow] Group chat extracted: fromuser=${fromuser}, groupid=${groupid}`);
  }

  if (!fromuser) {
    if (verbose) {
      console.log(`[infoflow] Group chat skipped: missing fromuser`);
    }
    return;
  }

  // Extract message content from body array or flat content field
  const message = msgData.message as Record<string, unknown> | undefined;
  const bodyItems = (message?.body ?? msgData.body ?? []) as InfoflowBodyItem[];

  // Resolve account to get robotName for mention detection
  const account = resolveInfoflowAccount({ cfg, accountId });
  const robotName = account.config.robotName;

  // Check if bot was @mentioned
  const wasMentioned = checkBotMentioned(bodyItems, robotName);

  if (verbose) {
    console.log(
      `[infoflow] Group chat mention check: robotName=${robotName ?? "not configured"}, wasMentioned=${wasMentioned}`,
    );
  }

  // Build two versions: mes (for CommandBody, no @xxx) and rawMes (for RawBody, with @xxx)
  let textContent = "";
  let rawTextContent = "";
  if (Array.isArray(bodyItems)) {
    for (const item of bodyItems) {
      if (item.type === "TEXT") {
        textContent += item.content ?? "";
        rawTextContent += item.content ?? "";
      } else if (item.type === "LINK") {
        const label = item.label ?? "";
        if (label) {
          textContent += ` ${label} `;
          rawTextContent += ` ${label} `;
        }
      } else if (item.type === "AT") {
        // AT elements only go into rawTextContent, not textContent
        const name = item.name ?? "";
        if (name) {
          rawTextContent += `@${name} `;
        }
      }
    }
  }

  const mes = textContent.trim() || String(msgData.content ?? msgData.text ?? "");
  const rawMes = rawTextContent.trim() || mes;

  if (!mes) {
    if (verbose) {
      console.log(`[infoflow] Group chat skipped: empty message content`);
    }
    return;
  }

  // Extract sender name from header or fallback to fromuser
  const senderName = String(header?.username ?? header?.nickname ?? msgData.username ?? fromuser);

  if (verbose) {
    console.log(
      `[infoflow] Group chat content: senderName=${senderName}, mes=${mes.slice(0, 50)}...`,
    );
  }

  // Delegate to the common message handler (group chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      rawMes,
      chatType: "group",
      groupId: groupid,
      senderName,
      wasMentioned,
      messageId: messageIdStr,
      timestamp,
    },
    accountId,
    statusSink,
  });
}

/**
 * Resolves route, builds envelope, records session meta, and dispatches reply for one incoming Infoflow message.
 * Called from monitor after webhook request is validated.
 */
export async function handleInfoflowMessage(params: HandleInfoflowMessageParams): Promise<void> {
  const { cfg, event, accountId, statusSink } = params;
  const { fromuser, mes, chatType, groupId, senderName } = event;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const core = getInfoflowRuntime();
  const verbose = core.logging.shouldLogVerbose();

  if (verbose) {
    console.log(
      `[infoflow] handleInfoflowMessage: chatType=${chatType}, fromuser=${fromuser}, groupId=${groupId || "N/A"}`,
    );
  }

  const isGroup = chatType === "group";
  // Convert groupId (number) to string for peerId since routing expects string
  const peerId = isGroup ? (groupId !== undefined ? String(groupId) : fromuser) : fromuser;

  // Resolve route based on chat type
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "infoflow",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Build conversation label and from address based on chat type
  const fromLabel = isGroup ? `group:${groupId}` : senderName || fromuser;
  const fromAddress = isGroup ? `infoflow:group:${groupId}` : `infoflow:${fromuser}`;
  const toAddress = isGroup ? `infoflow:${groupId}` : `infoflow:${account.accountId}`;

  if (verbose) {
    console.log(
      `[infoflow] Route resolved: agentId=${route.agentId}, sessionKey=${route.sessionKey}`,
    );
    console.log(`[infoflow] Address: From=${fromAddress}, To=${toAddress}`);
  }

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Infoflow",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: mes,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: event.rawMes ?? mes,
    CommandBody: mes,
    From: fromAddress,
    To: toAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? `group:${groupId}` : undefined,
    SenderName: senderName || fromuser,
    SenderId: fromuser,
    Provider: "infoflow",
    Surface: "infoflow",
    MessageSid: event.messageId ?? `${Date.now()}`,
    Timestamp: event.timestamp ?? Date.now(),
    OriginatingChannel: "infoflow",
    OriginatingTo: toAddress,
    WasMentioned: isGroup ? event.wasMentioned : undefined,
    CommandAuthorized: true,
  });

  if (verbose) {
    console.log("======ctxPayload======");
    console.log(ctxPayload);
  }
  // Record session using recordInboundSession for proper session tracking
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      if (verbose) {
        console.error(`[infoflow] failed updating session meta: ${String(err)}`);
      }
    },
  });

  // Mention gating: skip reply if requireMention is enabled and bot was not mentioned
  // Session is already recorded above for context history
  if (isGroup) {
    const requireMention = account.config.requireMention !== false;
    const canDetectMention = Boolean(account.config.robotName);
    const wasMentioned = event.wasMentioned === true;

    if (requireMention && canDetectMention && !wasMentioned) {
      if (verbose) {
        console.log(
          `[infoflow] Group message recorded but reply skipped: requireMention=true, wasMentioned=false`,
        );
      }
      return;
    }
  }

  const { dispatcherOptions, replyOptions } = createInfoflowReplyDispatcher({
    cfg,
    agentId: route.agentId,
    accountId: account.accountId,
    fromuser,
    chatType,
    groupId,
    statusSink,
  });

  if (verbose) {
    console.log(
      `[infoflow] Dispatching to OpenClaw: agentId=${route.agentId}, Body=${ctxPayload.Body?.slice(0, 100)}...`,
    );
  }

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions,
    replyOptions,
  });

  if (verbose) {
    console.log(`[infoflow] Dispatch completed for ${chatType} message from ${fromuser}`);
  }
}
