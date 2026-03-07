/**
 * 通用日志工具
 *
 * 提供分级日志功能:
 * - info: 关键业务日志（默认显示）
 * - debug: 调试日志（带 [DEBUG] 标记）
 * - error: 错误日志
 * - warn: 警告日志
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface LoggerOptions {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * 创建带前缀的日志器
 *
 * @param prefix 日志前缀（如 "dingtalk", "feishu"）
 * @param opts 可选的日志输出函数
 * @returns Logger 实例
 *
 * @example
 * ```ts
 * const logger = createLogger("dingtalk");
 * logger.debug("connecting..."); // [dingtalk] [DEBUG] connecting...
 * logger.info("connected");      // [dingtalk] connected
 * logger.warn("slow response");  // [dingtalk] [WARN] slow response
 * logger.error("failed");        // [dingtalk] [ERROR] failed
 * ```
 */
export function createLogger(prefix: string, opts?: LoggerOptions): Logger {
  const logFn = opts?.log ?? console.log;
  const errorFn = opts?.error ?? console.error;

  return {
    debug: (msg: string) => logFn(`[${prefix}] [DEBUG] ${msg}`),
    info: (msg: string) => logFn(`[${prefix}] ${msg}`),
    warn: (msg: string) => logFn(`[${prefix}] [WARN] ${msg}`),
    error: (msg: string) => errorFn(`[${prefix}] [ERROR] ${msg}`),
  };
}
