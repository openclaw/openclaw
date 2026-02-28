import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { downloadImageWeCom, saveInboundImage } from "./media.js";
import { createWeComReplyDispatcher } from "./reply-dispatcher.js";
import { getWeComRuntime } from "./runtime.js";
import { sendMessageWeCom, sendGroupMessageWeCom } from "./send.js";

export interface WeComMessageEvent {
  ToUserName: string; // 企业微信 CorpID
  FromUserName: string; // 发送者 UserID
  CreateTime: number; // 消息创建时间
  MsgType: string; // 消息类型：text, image, voice, video, file, location, link
  Content?: string; // 文本消息内容
  MsgId: string; // 消息 ID
  AgentID: string; // 企业应用 ID
  // Image message
  PicUrl?: string; // 图片链接
  MediaId?: string; // 媒体文件 ID
  // File message
  Title?: string; // 文件名
  Description?: string; // 文件描述
  FileKey?: string; // 文件 Key
  // Location message
  Location_X?: string; // 纬度
  Location_Y?: string; // 经度
  Scale?: string; // 地图缩放大小
  Label?: string; // 地理位置信息
  // Link message
  Url?: string; // 链接地址
  // Group chat
  ChatId?: string; // 群聊 ID (when in group)
  ChatType?: string; // 聊天类型: single (单聊) or group (群聊)
}

/**
 * Handle incoming WeCom message
 */
export async function handleWeComMessage({
  cfg,
  event,
  runtime,
  chatHistories,
  accountId,
}: {
  cfg: ClawdbotConfig;
  event: WeComMessageEvent;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Media list for images/files
  const mediaList: Array<{ path: string; contentType?: string | null }> = [];

  try {
    const userId = event.FromUserName;
    const messageId = event.MsgId;
    const msgType = event.MsgType;
    const chatId = event.ChatId;
    const chatType = event.ChatType ?? (chatId ? "group" : "single");
    const isGroupChat = chatType === "group" || !!chatId;

    // Resolve configured history limit (group vs DM)
    const wecomCfg = resolveWeComAccount({ cfg, accountId }).config;
    const DEFAULT_HISTORY_LIMIT = 20;
    const historyLimit = isGroupChat
      ? (wecomCfg?.historyLimit ?? DEFAULT_HISTORY_LIMIT)
      : (wecomCfg?.dmHistoryLimit ?? DEFAULT_HISTORY_LIMIT);

    // Check for duplicate messages
    try {
      const { tryRecordMessagePersistent } = await import("./dedup.js");
      const isNew = await tryRecordMessagePersistent(messageId, accountId ?? "default", log);
      if (!isNew) {
        log(`wecom[${accountId}]: duplicate message ${messageId}, skipping`);
        return;
      }
    } catch (dedupErr) {
      error(`wecom[${accountId}]: dedup check failed: ${String(dedupErr)}`);
      // Continue processing even if dedup fails
    }

    log(
      `wecom[${accountId}]: received ${msgType} message from ${userId} in ${isGroupChat ? "group" : "DM"}`,
    );

    // Build session key
    const sessionKey = isGroupChat
      ? `wecom:${accountId}:group:${chatId}`
      : `wecom:${accountId}:user:${userId}`;

    // Get or create history
    let history = chatHistories.get(sessionKey);
    if (!history) {
      history = [];
      chatHistories.set(sessionKey, history);
    }

    let messageText = "";

    // Handle different message types
    switch (msgType) {
      case "text":
        messageText = event.Content ?? "";
        break;

      case "image":
        // Download and save image
        if (event.MediaId) {
          try {
            log(`wecom[${accountId}]: downloading image (mediaId=${event.MediaId})...`);
            const { buffer, contentType, fileName } = await downloadImageWeCom({
              cfg,
              mediaId: event.MediaId,
              accountId,
            });
            const filePath = await saveInboundImage({
              buffer,
              fileName: fileName || "image.jpg",
              accountId: accountId || "default",
            });

            // Add to media list
            mediaList.push({ path: filePath, contentType: contentType || null });
            messageText = "[图片]";
            log(`wecom[${accountId}]: image downloaded: ${filePath}`);
          } catch (imgErr) {
            log(`wecom[${accountId}]: image download failed: ${String(imgErr)}`);
            messageText = "[图片]";
          }
        } else {
          messageText = "[图片]";
        }
        break;

      case "file":
        messageText = `[文件: ${event.Title ?? "未知"}]`;
        break;

      case "location":
        messageText = `[位置: ${event.Label ?? ""}] (${event.Location_X}, ${event.Location_Y})`;
        break;

      case "link":
        messageText = `[链接: ${event.Title ?? ""}] ${event.Url ?? ""}`;
        break;

      case "voice":
      case "video":
        messageText = `[${msgType === "voice" ? "语音" : "视频"}]`;
        log(`wecom[${accountId}]: ${msgType} message not fully supported yet`);
        break;

      default:
        log(`wecom[${accountId}]: unsupported message type: ${msgType}`);
        return;
    }

    // For group chats, check if bot should respond
    // Check group policy and allowlist
    if (isGroupChat) {
      const account = resolveWeComAccount({ cfg, accountId });
      const wecomCfg = account.config;

      // Import policy functions
      const { resolveWeComReplyPolicy, isWeComGroupAllowed } = await import("./policy.js");
      const { resolveDefaultGroupPolicy, resolveAllowlistProviderRuntimeGroupPolicy } =
        await import("openclaw/plugin-sdk");

      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.wecom !== undefined,
        groupPolicy: wecomCfg?.groupPolicy,
        defaultGroupPolicy,
      });

      // Check if group is allowed — use chatId, not userId (groupAllowFrom contains group IDs)
      if (
        !isWeComGroupAllowed({
          groupPolicy,
          allowFrom: wecomCfg?.groupAllowFrom ?? [],
          senderId: chatId ?? "",
        })
      ) {
        log(`wecom[${accountId}]: group ${chatId} not in allowlist, skipping`);
        return;
      }

      // Check mention policy
      const { requireMention } = resolveWeComReplyPolicy({
        isDirectMessage: false,
        globalConfig: wecomCfg,
      });

      if (requireMention) {
        // TODO: Implement proper @mention detection for WeCom
        // For now, skip if requireMention is true (WeCom doesn't provide mention info in basic events)
        log(`wecom[${accountId}]: group message without mention, skipping (requireMention=true)`);
        return;
      }
    }

    // For DMs, enforce dmPolicy (allowlist / pairing)
    if (!isGroupChat) {
      const account = resolveWeComAccount({ cfg, accountId });
      const wecomCfg = account.config;
      const dmPolicy = wecomCfg?.dmPolicy ?? "pairing";

      if (dmPolicy !== "open") {
        const { resolveWeComAllowlistMatch } = await import("./policy.js");
        const core = getWeComRuntime();
        const pairing = createScopedPairingAccess({
          core,
          channel: "wecom",
          accountId: account.accountId,
        });

        const configAllowFrom = (wecomCfg?.allowFrom ?? []).map(String);
        const storeAllowFrom =
          dmPolicy === "pairing" ? await pairing.readAllowFromStore().catch(() => []) : [];
        const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];

        const dmAllowed = resolveWeComAllowlistMatch({
          allowFrom: effectiveDmAllowFrom,
          senderId: userId,
        }).allowed;

        if (!dmAllowed) {
          if (dmPolicy === "pairing") {
            const { code, created } = await pairing.upsertPairingRequest({
              id: userId,
              meta: { name: userId },
            });
            if (created) {
              log(`wecom[${accountId}]: pairing request from ${userId}`);
              try {
                await sendMessageWeCom({
                  cfg,
                  to: userId,
                  text: core.channel.pairing.buildPairingReply({
                    channel: "wecom",
                    idLine: `Your WeCom user ID: ${userId}`,
                    code,
                  }),
                  accountId,
                });
              } catch (pairErr) {
                log(`wecom[${accountId}]: pairing reply failed for ${userId}: ${String(pairErr)}`);
              }
            }
          } else {
            log(
              `wecom[${accountId}]: blocked unauthorized DM from ${userId} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }
      }
    }

    // Get sender name for group chats
    let senderName = userId;
    if (isGroupChat) {
      try {
        const { getUserInfoWeCom } = await import("./directory.js");
        const userInfo = await getUserInfoWeCom({ cfg, userId, accountId });
        senderName = userInfo.name || userId;
      } catch (err) {
        log(`wecom[${accountId}]: failed to get sender name: ${String(err)}`);
      }
    }

    // Prefix message with sender name in group chats
    const displayMessage = isGroupChat ? `${senderName}: ${messageText}` : messageText;

    // Record user message in history
    recordPendingHistoryEntryIfEnabled({
      historyMap: chatHistories,
      historyKey: sessionKey,
      entry: {
        sender: senderName,
        body: messageText,
        timestamp: event.CreateTime * 1000,
        messageId: messageId,
      },
      limit: historyLimit,
    });

    // Build context for agent
    const core = getWeComRuntime();
    const historyContext = buildPendingHistoryContextFromMap({
      historyMap: chatHistories,
      historyKey: sessionKey,
      limit: historyLimit,
      currentMessage: displayMessage,
      formatEntry: (entry) =>
        core.channel.reply.formatAgentEnvelope({
          channel: "WeCom",
          from: isGroupChat ? `group:${chatId}` : userId,
          timestamp: new Date(),
          envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
          body: `${entry.sender}: ${entry.body}`,
        }),
    });

    // Resolve agent route
    const account = resolveWeComAccount({ cfg, accountId });
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wecom",
      accountId: account.accountId,
      peer: { kind: isGroupChat ? "group" : "direct", id: isGroupChat ? (chatId ?? "") : userId },
    });

    // Create reply dispatcher
    const { dispatcher, replyOptions, markDispatchIdle } = createWeComReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      userId,
      chatId,
      isGroupChat,
      accountId: account.accountId,
    });

    log(`wecom[${accountId}]: dispatching to agent (session=${route.sessionKey})`);

    // Build media payload
    const mediaPayload = buildAgentMediaPayload(mediaList);

    // Build context payload
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      CommandBody: historyContext,
      From: userId,
      To: account.corpId ?? "",
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroupChat ? "group" : "direct",
      GroupSubject: isGroupChat ? chatId : undefined,
      SenderName: senderName,
      SenderId: userId,
      Provider: "wecom" as const,
      Surface: "wecom" as const,
      MessageSid: messageId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "wecom" as const,
      OriginatingTo: account.corpId ?? "",
      ...mediaPayload,
    });

    // Dispatch to agent
    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    clearHistoryEntriesIfEnabled({
      historyMap: chatHistories,
      historyKey: sessionKey,
      limit: historyLimit,
    });

    log(
      `wecom[${accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`wecom[${accountId}]: error handling message: ${String(err)}`);
    if (err instanceof Error && err.stack) {
      error(`wecom[${accountId}]: stack trace: ${err.stack}`);
    }

    // Try to send error message
    try {
      const chatId = event.ChatId;
      const isGroupChat = event.ChatType === "group" || !!chatId;

      if (isGroupChat && chatId) {
        await sendGroupMessageWeCom({
          cfg,
          chatId,
          text: "抱歉，处理消息时出现错误。",
          accountId,
        });
      } else {
        await sendMessageWeCom({
          cfg,
          to: event.FromUserName,
          text: "抱歉，处理消息时出现错误。",
          accountId,
        });
      }
    } catch (sendErr) {
      error(`wecom[${accountId}]: failed to send error message: ${String(sendErr)}`);
    }
  }
}
