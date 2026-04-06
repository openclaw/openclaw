/**
 * OpenClaw 改进功能集成扩展
 * 
 * 将工具并发执行、Microcompact 和 Autocompact 集成到 OpenClaw 核心流程
 * 
 * 创建时间: 2026-04-06
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// 导入改进功能
import {
  applyMicrocompact,
  DEFAULT_MICROCOMPACT_CONFIG,
  type MicrocompactConfig
} from "../improvements/microcompact.js";

import {
  applyAutocompact,
  DEFAULT_AUTOCOMPACT_CONFIG,
  type AutocompactConfig
} from "../improvements/autocompact.js";

const log = createSubsystemLogger("improvements-integration");

/**
 * 改进功能的默认配置
 */
const IMPROVEMENTS_CONFIG = {
  microcompact: {
    enabled: true,
    ...DEFAULT_MICROCOMPACT_CONFIG
  },
  autocompact: {
    enabled: true,
    ...DEFAULT_AUTOCOMPACT_CONFIG
  }
} as const;

/**
 * 将 AgentMessage 转换为改进功能需要的消息格式
 */
function convertAgentMessageToImprovementMessage(msg: AgentMessage): any {
  return {
    type: msg.role,
    role: msg.role,
    message: {
      content: msg.content
    },
    timestamp: msg.timestamp
  };
}

/**
 * 将改进功能的消息格式转换回 AgentMessage
 */
function convertImprovementMessageToAgentMessage(msg: any): AgentMessage {
  return {
    role: msg.role,
    content: msg.message?.content || msg.content,
    timestamp: msg.timestamp
  };
}

/**
 * 应用改进功能到消息列表
 */
async function applyImprovementsToMessages(
  messages: AgentMessage[],
  model?: ExtensionContext["model"]
): Promise<{
  compactedMessages: AgentMessage[];
  microcompactApplied: boolean;
  autocompactApplied: boolean;
}> {
  log.info(`[Improvements] Applying improvements to ${messages.length} messages`);

  let compactedMessages = messages.map(convertAgentMessageToImprovementMessage);
  let microcompactApplied = false;
  let autocompactApplied = false;

  // 应用 Microcompact
  if (IMPROVEMENTS_CONFIG.microcompact.enabled) {
    try {
      log.info("[Improvements] Applying Microcompact...");
      compactedMessages = await applyMicrocompact(
        compactedMessages,
        IMPROVEMENTS_CONFIG.microcompact as MicrocompactConfig
      );
      microcompactApplied = true;
      log.info("[Improvements] Microcompact applied successfully");
    } catch (error) {
      log.error("[Improvements] Microcompact failed:", error);
    }
  }

  // 应用 Autocompact
  if (IMPROVEMENTS_CONFIG.autocompact.enabled && model) {
    try {
      log.info("[Improvements] Applying Autocompact...");
      compactedMessages = await applyAutocompact(
        compactedMessages,
        model,
        IMPROVEMENTS_CONFIG.autocompact as AutocompactConfig
      );
      autocompactApplied = true;
      log.info("[Improvements] Autocompact applied successfully");
    } catch (error) {
      log.error("[Improvements] Autocompact failed:", error);
    }
  }

  const resultMessages = compactedMessages.map(convertImprovementMessageToAgentMessage);
  log.info(
    `[Improvements] Completed: ${messages.length} → ${resultMessages.length} messages, ` +
    `Microcompact: ${microcompactApplied}, Autocompact: ${autocompactApplied}`
  );

  return {
    compactedMessages: resultMessages,
    microcompactApplied,
    autocompactApplied
  };
}

/**
 * OpenClaw 改进功能集成扩展
 * 
 * 监听会话事件，在适当的时机应用改进功能
 */
export default function improvementsIntegrationExtension(api: ExtensionAPI): void {
  log.info("[Improvements] Initializing improvements integration extension");

  // 监听会话压缩前事件
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation } = event;

    log.info(
      `[Improvements] session_before_compact triggered, ` +
      `messagesToSummarize: ${preparation.messagesToSummarize.length}, ` +
      `turnPrefixMessages: ${preparation.turnPrefixMessages.length}`
    );

    // 应用改进功能到 messagesToSummarize
    if (preparation.messagesToSummarize.length > 0) {
      const { compactedMessages } = await applyImprovementsToMessages(
        preparation.messagesToSummarize,
        ctx.model
      );
      
      // 更新 preparation 中的消息
      preparation.messagesToSummarize = compactedMessages;
      log.info(`[Improvements] Updated messagesToSummarize: ${compactedMessages.length} messages`);
    }

    // 应用改进功能到 turnPrefixMessages
    if (preparation.turnPrefixMessages.length > 0) {
      const { compactedMessages } = await applyImprovementsToMessages(
        preparation.turnPrefixMessages,
        ctx.model
      );
      
      // 更新 preparation 中的消息
      preparation.turnPrefixMessages = compactedMessages;
      log.info(`[Improvements] Updated turnPrefixMessages: ${compactedMessages.length} messages`);
    }

    // 返回 undefined 继续正常的压缩流程
    return undefined;
  });

  // 监听会话创建事件
  api.on("session_created", async (event, ctx) => {
    log.info(`[Improvements] session_created triggered for session ${event.sessionId}`);
  });

  // 监听会话销毁事件
  api.on("session_destroyed", async (event, ctx) => {
    log.info(`[Improvements] session_destroyed triggered for session ${event.sessionId}`);
  });

  log.info("[Improvements] Improvements integration extension initialized");
}
