/**
 * createRuntimeLogger — 为 ClaWorks 运行时提供结构化、分级日志封装。
 *
 * 对外兼容：底层仍调用宿主注入的 `(msg: string) => void`，
 * 上层调用统一用 info/warn/error/debug 级别区分。
 */

/**
 * 对日志消息中的敏感字段进行脱敏替换，防止凭证泄漏到日志系统。
 * 只处理消息文本，不影响实际数据流。
 */
export function redactSensitive(msg: string): string {
  return msg
    .replace(/(password|secret|api_key|token|credential)[=:\s]+\S+/gi, "$1=***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  debug(msg: string): void;
  /** 原始写入，不添加时间戳前缀（内部使用） */
  raw(msg: string): void;
};

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 解析 LOG_LEVEL 环境变量（无效值回退 info）。 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

/**
 * 创建结构化 logger，将 info/warn/error/debug 格式化后转发给底层 `base` 函数。
 *
 * @param base  宿主注入的原始日志函数；未提供时静默（生产环境宿主可覆写）。
 * @param ns    日志命名空间前缀，如 `"claworks:runtime"`。
 * @param minLevel  最低输出级别；默认读取 LOG_LEVEL 环境变量。
 */
export function createRuntimeLogger(
  base?: (msg: string) => void,
  ns = "claworks",
  minLevel: LogLevel = resolveLogLevel(),
): RuntimeLogger {
  const write = base ?? (() => {});
  const minRank = LOG_LEVEL_RANK[minLevel];

  function shouldEmit(level: LogLevel): boolean {
    return LOG_LEVEL_RANK[level] >= minRank;
  }

  function ts(): string {
    return new Date().toISOString();
  }

  function format(level: string, msg: string): string {
    return `[${ts()} ${level}] [${ns}] ${msg}`;
  }

  return {
    raw(msg) {
      write(msg);
    },
    info(msg) {
      if (!shouldEmit("info")) {
        return;
      }
      write(format("INFO ", redactSensitive(msg)));
    },
    warn(msg) {
      if (!shouldEmit("warn")) {
        return;
      }
      write(format("WARN ", redactSensitive(msg)));
    },
    error(msg, err?: unknown) {
      if (!shouldEmit("error")) {
        return;
      }
      write(format("ERROR", redactSensitive(msg)));
      if (err != null) {
        const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
        write(format("ERROR", `  ↳ ${redactSensitive(stack)}`));
      }
    },
    debug(msg) {
      if (!shouldEmit("debug")) {
        return;
      }
      write(format("DEBUG", redactSensitive(msg)));
    },
  };
}
