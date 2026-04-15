/**
 * Session-level serial queue
 *
 * 按 sessionKey 维度维护独立的 promise chain，
 * 保证同一 sessionKey 的任务顺序执行，不同 sessionKey 之间并行。
 *
 * 当某个 sessionKey 的 chain 空闲后自动清理，避免内存泄漏。
 */

import { createLog } from "../../logger.js";

export type SessionTask = () => Promise<void>;

export class SessionQueue {
  /** sessionKey → 当前 promise chain */
  private chains = new Map<string, Promise<void>>();
  /** sessionKey → 当前 generation（用于判断任务是否已被打断） */
  private generations = new Map<string, number>();
  private log = createLog("session-queue");

  /**
   * 使指定 sessionKey 的所有排队中任务失效。
   *
   * 递增 generation 计数器，后续 enqueue 的任务在执行前会比对 generation，
   * Skip execution if already changed (superseded by an updated message).
   *
   * @param sessionKey - 要失效的会话标识
   */
  invalidate(sessionKey: string): void {
    const gen = (this.generations.get(sessionKey) ?? 0) + 1;
    this.generations.set(sessionKey, gen);
    this.log.info(`[${sessionKey}] invalidated queued tasks (generation=${gen})`);
  }

  /**
   * 将任务入队到指定 sessionKey 的串行队列中
   *
   * @param sessionKey - 会话标识（如 `group:accountId:groupCode` 或 `c2c:accountId:fromAccount`）
   * @param task - 要执行的异步任务
   */
  enqueue(sessionKey: string, task: SessionTask): Promise<void> {
    // 记录入队时的 generation，执行前比对以判断是否已被打断
    const enqueuedGen = this.generations.get(sessionKey) ?? 0;
    const prev = this.chains.get(sessionKey) ?? Promise.resolve();

    const next = prev
      .then(() => {
        // generation 已变化 → 有新消息打断，跳过此任务
        const currentGen = this.generations.get(sessionKey) ?? 0;
        if (currentGen !== enqueuedGen) {
          this.log.info(
            `[${sessionKey}] task skipped (superseded, enqueued=${enqueuedGen}, current=${currentGen})`,
          );
          return undefined;
        }
        return task();
      })
      .catch((err) => {
        this.log.error(`session queue task error [${sessionKey}]: ${String(err)}`);
      })
      .finally(() => {
        // 如果当前 chain 仍是我们刚创建的这个，说明没有新任务入队，可以清理
        if (this.chains.get(sessionKey) === next) {
          this.chains.delete(sessionKey);
          this.generations.delete(sessionKey);
        }
      });

    this.chains.set(sessionKey, next);
    return next;
  }

  /** 当前活跃的 session 数量（用于调试/监控） */
  get activeCount(): number {
    return this.chains.size;
  }
}
