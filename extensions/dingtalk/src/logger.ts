/**
 * 钉钉插件日志工具
 * 统一日志前缀，保持输出格式一致
 */

const PREFIX = "[DingTalk]";

export const logger = {
  log: (message: string) => console.log(`${PREFIX} ${message}`),
  info: (message: string) => console.info(`${PREFIX} ${message}`),
  warn: (message: string) => console.warn(`${PREFIX} ${message}`),
  error: (message: string, err?: unknown) => {
    if (err) {
      console.error(`${PREFIX} ${message}`, err);
    } else {
      console.error(`${PREFIX} ${message}`);
    }
  },
};
