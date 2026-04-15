/**
 * 会话级 AbortController 管理器
 *
 * 为每个 sessionKey 维护一个 AbortController，
 * 当新消息需要打断旧推理时，调用 rotate() 即可 abort 旧的并创建新的。
 */

import { createLog } from "../../logger.js";

const log = createLog("session-abort");

export class SessionAbortManager {
  /** sessionKey → 当前活跃的 AbortController */
  private controllers = new Map<string, AbortController>();

  /**
   * 轮换指定 session 的 AbortController：
   * 1. abort 旧的 controller（终止正在进行的推理）
   * 2. 创建新的 controller 并返回其 signal
   *
   * @param sessionKey - 会话标识
   * @returns 新的 AbortSignal，供后续管线使用
   */
  rotate(sessionKey: string): AbortSignal {
    const existing = this.controllers.get(sessionKey);
    if (existing) {
      log.info(`[${sessionKey}] aborting previous inference`);
      existing.abort();
    }

    const controller = new AbortController();
    this.controllers.set(sessionKey, controller);
    return controller.signal;
  }

  /**
   * 任务完成后清理 controller（避免内存泄漏）
   *
   * 仅当 map 中存储的仍是同一个 controller 时才删除，
   * 防止误删后续 rotate() 创建的新 controller。
   *
   * @param sessionKey - 会话标识
   * @param signal - 要清理的 signal（用于身份比对）
   */
  cleanup(sessionKey: string, signal: AbortSignal): void {
    const current = this.controllers.get(sessionKey);
    if (current && current.signal === signal) {
      this.controllers.delete(sessionKey);
    }
  }

  /** 当前活跃的 session 数量（用于调试/监控） */
  get activeCount(): number {
    return this.controllers.size;
  }
}
