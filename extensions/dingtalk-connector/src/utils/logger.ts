/**
 * 日志工具模块
 * 根据 debug 配置控制日志输出
 */

/**
 * 创建日志记录器
 * @param debug - 是否启用 debug 模式
 * @param prefix - 日志前缀
 * @returns 日志记录器对象
 */
export function createLogger(debug: boolean = false, prefix: string = '') {
  const logger = {
    /**
     * 打印 info 级别日志
     * 仅在 debug 模式下输出
     */
    info(...args: any[]) {
      if (debug) {
        if (prefix) {
          console.log(`[${prefix}]`, ...args);
        } else {
          console.log(...args);
        }
      }
    },

    /**
     * 打印 warn 级别日志
     * 始终输出
     */
    warn(...args: any[]) {
      if (prefix) {
        console.warn(`[${prefix}]`, ...args);
      } else {
        console.warn(...args);
      }
    },

    /**
     * 打印 error 级别日志
     * 始终输出
     */
    error(...args: any[]) {
      if (prefix) {
        console.error(`[${prefix}]`, ...args);
      } else {
        console.error(...args);
      }
    },

    /**
     * 打印 debug 级别日志
     * 仅在 debug 模式下输出
     */
    debug(...args: any[]) {
      if (debug) {
        if (prefix) {
          console.log(`[DEBUG][${prefix}]`, ...args);
        } else {
          console.log('[DEBUG]', ...args);
        }
      }
    },
  };

  return logger;
}

/**
 * 从配置中创建日志记录器
 * @param config - 包含 debug 配置的对象（可选）
 * @param prefix - 日志前缀
 * @returns 日志记录器对象
 */
export function createLoggerFromConfig(config: { debug?: boolean } | undefined | null, prefix: string = '') {
  return createLogger(!!config?.debug, prefix);
}
