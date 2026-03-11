/**
 * Feishu Message Loss Recovery - 消息丢失恢复模块
 * 
 * 功能：定期检查群聊消息，发现并恢复丢失的消息
 * 
 * 安装方式：
 * 1. 复制到 openclaw/extensions/feishu/src/
 * 2. 在 monitor.account.ts 中导入并调用
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { botOpenIds, botNames } from "./monitor.state.js";
import { hasRecordedMessage, hasRecordedMessagePersistent } from "./dedup.js";
import { handleFeishuMessage, parseFeishuMessageEvent } from "./bot.js";

// 配置
const RECOVERY_CONFIG = {
  CHECK_INTERVAL_MS: 30000,  // 30秒检查一次
  MESSAGE_LIMIT: 20,         // 每次获取20条消息
  MAX_CHATS: 10,            // 最多检查10个群
};

const state = new Map<string, {
  intervalId: NodeJS.Timeout | null;
  stats: {
    checksPerformed: number;
    messagesRecovered: number;
    errors: number;
    lastCheckTime: number | null;
  };
}>();

function getState(accountId: string) {
  if (!state.has(accountId)) {
    state.set(accountId, {
      intervalId: null,
      stats: { checksPerformed: 0, messagesRecovered: 0, errors: 0, lastCheckTime: null },
    });
  }
  return state.get(accountId)!;
}

export function startMessageRecovery(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
}): void {
  const { cfg, accountId, runtime } = params;
  const log = runtime?.log ?? console.log;
  const s = getState(accountId);
  
  if (s.intervalId) {
    clearInterval(s.intervalId);
  }
  
  log(`feishu[${accountId}]: 启动消息恢复服务 (间隔: ${RECOVERY_CONFIG.CHECK_INTERVAL_MS}ms)`);
  
  s.intervalId = setInterval(async () => {
    await performRecoveryCheck(accountId, cfg, runtime);
  }, RECOVERY_CONFIG.CHECK_INTERVAL_MS);
}

export function stopMessageRecovery(accountId: string): void {
  const s = state.get(accountId);
  if (s?.intervalId) {
    clearInterval(s.intervalId);
    s.intervalId = null;
  }
}

export function getRecoveryStats(accountId: string) {
  return state.get(accountId)?.stats || null;
}

async function performRecoveryCheck(
  accountId: string,
  cfg: ClawdbotConfig,
  runtime?: RuntimeEnv
): Promise<number> {
  const log = runtime?.log ?? console.log;
  const s = getState(accountId);
  
  s.stats.checksPerformed++;
  s.stats.lastCheckTime = Date.now();
  
  try {
    const account = resolveFeishuAccount({ cfg, accountId });
    const client = account.client as Lark.IM;
    const botOpenId = botOpenIds.get(accountId);
    const botName = botNames.get(accountId);
    
    // 获取群聊列表
    const chatsResp = await client.listChatMembers({
      params: { member_id_type: "user_id" },
    });
    
    const chatIds = chatsResp.data?.items?.slice(0, RECOVERY_CONFIG.MAX_CHATS)
      .map(item => item.chat_id)
      .filter(Boolean) || [];
    
    let recovered = 0;
    
    for (const chatId of chatIds) {
      try {
        const msgsResp = await client.listChatMessage({
          params: {
            container_id_type: "chat_id",
            container_id: chatId,
            sort: "ByTime",
            order: "desc",
            limit: RECOVERY_CONFIG.MESSAGE_LIMIT,
          },
        });
        
        const messages = msgsResp.data?.items || [];
        
        for (const msg of messages) {
          const msgId = msg.message_id;
          if (!msgId) continue;
          
          // 检查是否已处理
          const key = `${accountId}:${msgId}`;
          if (hasRecordedMessage(key)) continue;
          if (await hasRecordedMessagePersistent(msgId, accountId, log)) continue;
          
          // 检查是否提及机器人
          const content = msg.body?.content || "";
          const text = content.toLowerCase();
          
          const mentioned = 
            (botOpenId && text.includes(botOpenId.toLowerCase())) ||
            (botName && text.toLowerCase().includes(botName.toLowerCase())) ||
            content.includes("@");
          
          if (!mentioned) continue;
          
          // 处理恢复的消息
          try {
            const event = {
              sender: {
                sender_id: msg.sender?.sender_id || {},
                sender_type: msg.sender?.sender_type || "user",
              },
              message: {
                message_id: msgId,
                chat_id: msg.body?.chat_id || "",
                chat_type: msg.body?.chat_type || "p2p",
                message_type: msg.body?.message_type || "text",
                content: content,
                create_time: msg.create_time,
              },
            };
            
            await handleFeishuMessage({
              cfg,
              event,
              botOpenId,
              botName,
              runtime,
              chatHistories: new Map(),
              accountId,
            });
            
            recovered++;
            s.stats.messagesRecovered++;
            log(`feishu[${accountId}]: 恢复消息 ${msgId}`);
          } catch (err) {
            log(`feishu[${accountId}]: 处理消息 ${msgId} 失败: ${String(err)}`);
          }
        }
      } catch (err) {
        log(`feishu[${accountId}]: 检查群 ${chatId} 失败: ${String(err)}`);
      }
    }
    
    return recovered;
  } catch (err) {
    s.stats.errors++;
    log(`feishu[${accountId}]: 恢复检查失败: ${String(err)}`);
    return 0;
  }
}

// 手动触发恢复
export async function triggerManualRecovery(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
}): Promise<number> {
  return performRecoveryCheck(params.accountId, params.cfg, params.runtime);
}
