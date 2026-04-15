/**
 * Yuanbao 插件公共日志模块
 *
 * 使用方式：
 * 1. 插件注册阶段调用 initLogger(api) 初始化（仅一次）
 * 2. 之后在任意模块中使用导出的便捷方法：
 *    - logger.info("消息")          // 关键事件
 *    - logger.warn("消息")          // 可忽略但需注意
 *    - logger.error("消息")         // 真正的错误
 *    - logger.debug("消息")         // 调试信息（需 --verbose 或 level=debug）
 *    - logger.info("消息", { k: v })  // 附带结构化 meta
 * 3. Runtime未初始化前会自动降级到 console 输出
 *
 * Log levels:
 * - info: 关键事件（启动、收发消息成功）
 * - warn: 可忽略但需注意（配置缺失、跳过处理）
 * - error: 真正的错误（发送失败、签名错误）
 * - debug: 详细调试信息（仅 verbose 模式可见）
 *
 * View logs:
 * - openclaw logs --follow
 * - openclaw gateway --verbose（显示 debug 级别）
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getPluginVersion } from "./infra/env.js";

/** 缓存的日志前缀，initLogger 时刷新 */
let LOG_PREFIX = "[yuanbao]";

/** 根据当前版本号刷新日志前缀 */
function refreshLogPrefix(): void {
  const ver = getPluginVersion();
  LOG_PREFIX = ver ? `[yuanbao:${ver}]` : "[yuanbao]";
}

// ============ 类型定义 ============

/** 插件 logger 实例类型（兼容 OpenClaw childLogger） */
export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// ============ 内部状态 ============

/** OpenClaw childLogger 实例（initLogger 后可用） */
let childLogger: PluginLogger | null = null;

/** 是否已初始化 */
let initialized = false;

/** 是否开启了 verbose 模式 */
let verboseEnabled = false;

// ============ 降级 logger（Runtime未初始化前使用） ============

const fallbackLogger: PluginLogger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
};

// ============ 初始化 ============

/**
 * 初始化插件 logger
 *
 * 在插件 register 阶段调用，基于 OpenClaw API 创建带 plugin 标识的子 logger。
 * 初始化后所有导出的日志方法会自动切换到 OpenClaw logger 输出。
 *
 * @param api - OpenClaw 插件 API 实例
 */
export function initLogger(api: OpenClawPluginApi): void {
  try {
    childLogger = api.runtime.logging.getChildLogger({ plugin: "yuanbao" }) as PluginLogger;
    verboseEnabled = api.runtime.logging.shouldLogVerbose?.() ?? false;
    refreshLogPrefix();
    initialized = true;
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to initialize logger, falling back to console`, err);
  }
}

// ============ 公共日志方法 ============

/**
 * 获取当前活跃的 logger 实例
 *
 * Runtime已初始化则返回 OpenClaw childLogger，否则返回 console 降级 logger。
 */
function getActiveLogger(): PluginLogger {
  if (initialized && childLogger) {
    const cl = childLogger;
    return {
      info: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.info(message, meta) : cl.info(message),
      warn: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.warn(message, meta) : cl.warn(message),
      error: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.error(message, meta) : cl.error(message),
      debug: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.debug?.(message, meta) : cl.debug?.(message),
    };
  }
  return fallbackLogger;
}

/**
 * 插件公共 logger 实例
 *
 * Usage:
 * ```ts
 * import { logger } from "../logger.js";
 *
 * logger.info("插件已加载");
 * logger.warn("配置缺失", { key: "appSecret" });
 * logger.error("发送失败", { error: err.message });
 * logger.debug("调试信息");
 * ```
 */
export const logger: PluginLogger = {
  info(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().info(message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().warn(message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().error(message, meta);
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().debug(message, meta);
  },
};

/**
 * 检查是否开启了 verbose 模式
 *
 * Can be used in critical paths to decide whether to output extra debug info, avoiding unnecessary string concatenation overhead.
 *
 * @returns 是否开启了 verbose 模式
 */
export function isVerbose(): boolean {
  return verboseEnabled;
}

// ============ 调试白名单（跳过脱敏） ============

/**
 * 从Environment variables YUANBAO_DEBUG_BOT_IDS 解析白名单 botId。
 * 支持逗号分隔，例如 YUANBAO_DEBUG_BOT_IDS=bot_aaa,bot_bbb
 */
function parseEnvDebugBotIds(): string[] {
  const raw = process.env.YUANBAO_DEBUG_BOT_IDS;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 白名单 botId 集合，命中时日志不做脱敏 */
const debugBotIds = new Set<string>(parseEnvDebugBotIds());

/**
 * 设置调试白名单 botId 列表
 *
 * 将 YAML 配置中的 `channels.yuanbao.debugBotIds` 与Environment variables
 * `YUANBAO_DEBUG_BOT_IDS` 合并写入白名单。白名单内的 botId 产生的日志
 * Sanitization will be skipped to facilitate debugging during development.
 *
 * 通常在 gateway.startAccount 中从配置读取后调用。
 *
 * @param ids - YAML 配置中的 botId 数组，会与Environment variables中的白名单合并
 */
export function setDebugBotIds(ids: string[]): void {
  debugBotIds.clear();
  for (const id of parseEnvDebugBotIds()) {
    debugBotIds.add(id);
  }
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed) {
      debugBotIds.add(trimmed);
    }
  }
}

/**
 * 判断指定 botId 是否在调试白名单中
 *
 * @param botId - 待检查的 botId，为空时直接返回 false
 * @returns 该 botId 是否命中调试白名单
 */
export function isDebugBotId(botId?: string): boolean {
  if (!botId) {
    return false;
  }
  return debugBotIds.has(botId);
}

// ============ 统一日志工厂 ============

/** 通用日志 sink 接口 — 兼容 logger 单例、ctx.log、透传 GatewayLog 等所有来源 */
export interface LogSink {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
  verbose?: (msg: string) => void;
}

/** createLog 返回的统一日志接口 */
export interface ModuleLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

/**
 * 格式化日志消息：拼接 LOG_PREFIX + module 前缀，并对 data 自动脱敏。
 *
 * @param module - 模块标识（如 'ws', 'inbound', accountId 等）
 * @param msg - 日志正文
 * @param data - 可选的结构化数据，自动经过 sanitize 脱敏
 * @returns 格式化后的完整日志字符串
 */
/**
 * 格式化日志消息：拼接 LOG_PREFIX + module 前缀，并对 data 自动脱敏。
 *
 * @param module - 模块标识（如 'ws', 'inbound', accountId 等）
 * @param msg - 日志正文
 * @param data - 可选的结构化数据，自动经过 sanitize 脱敏
 * @param skipSanitize - 若为 true 则跳过脱敏，直接 JSON.stringify 输出
 * @returns 格式化后的完整日志字符串
 */
export function formatLog(
  module: string,
  msg: string,
  data?: Record<string, unknown>,
  skipSanitize?: boolean,
): string {
  const prefix = module ? `${LOG_PREFIX}[${module}]` : LOG_PREFIX;
  if (data === undefined) {
    return `${prefix} ${msg}`;
  }
  const serialized = skipSanitize ? JSON.stringify(data) : sanitize(data);
  return `${prefix} ${msg} ${serialized}`;
}

/**
 * 创建模块级Logger instance
 *
 * Auto-complete:
 * 1. 拼接 LOG_PREFIX[module] 前缀
 * 2. sanitize(data) 脱敏
 * 3. 适配任意 logger sink
 *
 * @param module - 模块标识（如 'ws', 'inbound', 'outbound', accountId 等）
 * @param sink - 日志输出目标（logger 单例、ctx.log、透传 log 对象），不传则使用 logger 单例
 * @returns 带有 info/warn/error/debug 方法的模块Logger instance，调用时自动拼接前缀并脱敏
 *
 * @example
 * ```ts
 * const log = createLog('inbound', ctx.log);
 * log.info('received message', { from: userId });
 * log.error('processing failed', { error: String(err) });
 * ```
 */
export function createLog(module: string, sink?: LogSink, options?: { botId?: string }): ModuleLog {
  const target = sink ?? logger;
  const skipSanitize = isDebugBotId(options?.botId);

  function fmt(msg: string, data?: Record<string, unknown>): string {
    return formatLog(module, msg, data, skipSanitize);
  }

  return {
    info: (msg, data) => target.info?.(fmt(msg, data)),
    warn: (msg, data) => target.warn?.(fmt(msg, data)),
    error: (msg, data) => target.error?.(fmt(msg, data)),
    debug: (msg, data) => (target.debug ?? (target as LogSink).verbose)?.(fmt(msg, data)),
  };
}

// ============ 兼容旧 API ============

/**
 * 需要在日志输出中完全删除的字段名集合
 */
const OMIT_KEYS = new Set(["msg_body"]);

/**
 * 需要在日志中脱敏的敏感字段名集合
 */
const SENSITIVE_KEYS = new Set([
  "token",
  "signature",
  "app_key",
  "appkey",
  "appsecret",
  "app_secret",
  "secret",
  "password",
  "x-token",
  "user_input",
  "cloud_custom_data",
  "model_output",
]);

/**
 * 遮蔽字符串值，保留首尾各 3 个字符。
 * 长度小于 8 的字符串将被完全遮蔽。
 *
 * @example maskValue("abcdefghij") => "abc****hij"
 */
function maskValue(value: string): string {
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

/**
 * Sanitize sensitive fields before writing to logs.
 * 接受对象、JSON 字符串或基本类型。
 *
 * - 对象/数组：递归遮蔽敏感字段的值
 * - JSON 字符串：解析 → 脱敏 → 重新序列化
 * - 其他类型：原样返回
 *
 * @param value - 需要脱敏的值，可以是对象、JSON 字符串或基本类型
 * @returns 脱敏后的字符串表示
 */
export function sanitize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "string") {
    // 尝试将 JSON 字符串解析为对象，以便对内部字段进行脱敏
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(sanitizeObj(parsed as Record<string, unknown>));
      }
    } catch {
      // 非 JSON 字符串，原样返回
    }
    return value;
  }

  if (typeof value === "object") {
    return JSON.stringify(sanitizeObj(value as Record<string, unknown>));
  }

  // 基本类型（number / boolean / bigint / symbol / function）
  return typeof value === "symbol"
    ? value.toString()
    : String(value as string | number | boolean | bigint);
}

function sanitizeObj(obj: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === "object" && item !== null ? sanitizeObj(item) : item,
    ) as unknown as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (OMIT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof val === "string") {
      result[key] = maskValue(val);
    } else if (typeof val === "object" && val !== null) {
      result[key] = sanitizeObj(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }

  return result;
}
