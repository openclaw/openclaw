/**
 * EventDedup — 事件去重守卫（防止相同事件短时间内重复触发相同 Playbook）。
 *
 * 解决「能量守恒」问题：同源事件 60 秒内不重复触发相同 Playbook。
 * 去重键：source + eventType + playbookId。
 */

export type DedupGuard = {
  /** 检查是否应跳过（已在窗口内处理过） */
  shouldSkip(key: string): boolean;
  /** 记录一次触发 */
  record(key: string): void;
  /** 构建去重键 */
  buildKey(source: string, eventType: string, playbookId: string): string;
};

export function createDedupGuard(windowMs = 60_000): DedupGuard {
  const seen = new Map<string, number>();

  function sweep(): void {
    const now = Date.now();
    for (const [k, ts] of seen.entries()) {
      if (now - ts > windowMs) {
        seen.delete(k);
      }
    }
  }

  return {
    shouldSkip(key) {
      sweep();
      return seen.has(key);
    },

    record(key) {
      seen.set(key, Date.now());
    },

    buildKey(source, eventType, playbookId) {
      return `${source}\x00${eventType}\x00${playbookId}`;
    },
  };
}
