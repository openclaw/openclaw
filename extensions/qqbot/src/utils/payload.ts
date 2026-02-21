/**
 * QQBot 结构化消息载荷工具
 *
 * 用于处理 AI 输出的结构化消息载荷，包括：
 * - 定时提醒载荷 (cron_reminder)
 * - 媒体消息载荷 (media)
 */

// ============================================
// 类型定义
// ============================================

/**
 * 定时提醒载荷
 */
export interface CronReminderPayload {
  type: "cron_reminder";
  /** 提醒内容 */
  content: string;
  /** 目标类型：c2c (私聊) 或 group (群聊) */
  targetType: "c2c" | "group";
  /** 目标地址：user_openid 或 group_openid */
  targetAddress: string;
  /** 原始消息 ID（可选） */
  originalMessageId?: string;
}

/**
 * 媒体消息载荷
 */
export interface MediaPayload {
  type: "media";
  /** 媒体类型：image, audio, video */
  mediaType: "image" | "audio" | "video";
  /** 来源类型：url 或 file */
  source: "url" | "file";
  /** 媒体路径或 URL */
  path: string;
  /** 媒体描述（可选） */
  caption?: string;
}

/**
 * QQBot 载荷联合类型
 */
export type QQBotPayload = CronReminderPayload | MediaPayload;

/**
 * 解析结果
 */
export interface ParseResult {
  /** 是否为结构化载荷 */
  isPayload: boolean;
  /** 解析后的载荷对象（如果是结构化载荷） */
  payload?: QQBotPayload;
  /** 原始文本（如果不是结构化载荷） */
  text?: string;
  /** 解析错误信息（如果解析失败） */
  error?: string;
}

// ============================================
// 常量定义
// ============================================

/** AI 输出的结构化载荷前缀 */
const PAYLOAD_PREFIX = "QQBOT_PAYLOAD:";

/** Cron 消息存储的前缀 */
const CRON_PREFIX = "QQBOT_CRON:";

// ============================================
// 解析函数
// ============================================

/**
 * 解析 AI 输出的结构化载荷
 *
 * 检测消息是否以 QQBOT_PAYLOAD: 前缀开头，如果是则提取并解析 JSON
 *
 * @param text AI 输出的原始文本
 * @returns 解析结果
 *
 * @example
 * const result = parseQQBotPayload('QQBOT_PAYLOAD:\n{"type": "media", "mediaType": "image", ...}');
 * if (result.isPayload && result.payload) {
 *   // 处理结构化载荷
 * }
 */
export function parseQQBotPayload(text: string): ParseResult {
  const trimmedText = text.trim();

  // 检查是否以 QQBOT_PAYLOAD: 开头
  if (!trimmedText.startsWith(PAYLOAD_PREFIX)) {
    return {
      isPayload: false,
      text: text,
    };
  }

  // 提取 JSON 内容（去掉前缀）
  const jsonContent = trimmedText.slice(PAYLOAD_PREFIX.length).trim();

  if (!jsonContent) {
    return {
      isPayload: true,
      error: "载荷内容为空",
    };
  }

  try {
    const payload = JSON.parse(jsonContent) as QQBotPayload;

    // 验证必要字段
    if (!payload.type) {
      return {
        isPayload: true,
        error: "载荷缺少 type 字段",
      };
    }

    // 根据 type 进行额外验证
    if (payload.type === "cron_reminder") {
      if (!payload.content || !payload.targetType || !payload.targetAddress) {
        return {
          isPayload: true,
          error: "cron_reminder 载荷缺少必要字段 (content, targetType, targetAddress)",
        };
      }
    } else if (payload.type === "media") {
      if (!payload.mediaType || !payload.source || !payload.path) {
        return {
          isPayload: true,
          error: "media 载荷缺少必要字段 (mediaType, source, path)",
        };
      }
    }

    return {
      isPayload: true,
      payload,
    };
  } catch (e) {
    return {
      isPayload: true,
      error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================
// Cron 编码/解码函数
// ============================================

/**
 * 将定时提醒载荷编码为 Cron 消息格式
 *
 * 将 JSON 编码为 Base64，并添加 QQBOT_CRON: 前缀
 *
 * @param payload 定时提醒载荷
 * @returns 编码后的消息字符串，格式为 QQBOT_CRON:{base64}
 *
 * @example
 * const message = encodePayloadForCron({
 *   type: 'cron_reminder',
 *   content: '喝水时间到！',
 *   targetType: 'c2c',
 *   targetAddress: 'user_openid_xxx'
 * });
 * // 返回: QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...
 */
export function encodePayloadForCron(payload: CronReminderPayload): string {
  const jsonString = JSON.stringify(payload);
  const base64 = Buffer.from(jsonString, "utf-8").toString("base64");
  return `${CRON_PREFIX}${base64}`;
}

/**
 * 解码 Cron 消息中的载荷
 *
 * 检测 QQBOT_CRON: 前缀，解码 Base64 并解析 JSON
 *
 * @param message Cron 触发时收到的消息
 * @returns 解码结果，包含是否为 Cron 载荷、解析后的载荷对象或错误信息
 *
 * @example
 * const result = decodeCronPayload('QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...');
 * if (result.isCronPayload && result.payload) {
 *   // 处理定时提醒
 * }
 */
export function decodeCronPayload(message: string): {
  isCronPayload: boolean;
  payload?: CronReminderPayload;
  error?: string;
} {
  const trimmedMessage = message.trim();

  // 检查是否以 QQBOT_CRON: 开头
  if (!trimmedMessage.startsWith(CRON_PREFIX)) {
    return {
      isCronPayload: false,
    };
  }

  // 提取 Base64 内容
  const base64Content = trimmedMessage.slice(CRON_PREFIX.length);

  if (!base64Content) {
    return {
      isCronPayload: true,
      error: "Cron 载荷内容为空",
    };
  }

  try {
    // Base64 解码
    const jsonString = Buffer.from(base64Content, "base64").toString("utf-8");
    const payload = JSON.parse(jsonString) as CronReminderPayload;

    // 验证类型
    if (payload.type !== "cron_reminder") {
      return {
        isCronPayload: true,
        error: `期望 type 为 cron_reminder，实际为 ${String(payload.type)}`,
      };
    }

    // 验证必要字段
    if (!payload.content || !payload.targetType || !payload.targetAddress) {
      return {
        isCronPayload: true,
        error: "Cron 载荷缺少必要字段",
      };
    }

    return {
      isCronPayload: true,
      payload,
    };
  } catch (e) {
    return {
      isCronPayload: true,
      error: `Cron 载荷解码失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================
// 辅助函数
// ============================================

/**
 * 判断载荷是否为定时提醒类型
 */
export function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload {
  return payload.type === "cron_reminder";
}

/**
 * 判断载荷是否为媒体消息类型
 */
export function isMediaPayload(payload: QQBotPayload): payload is MediaPayload {
  return payload.type === "media";
}
