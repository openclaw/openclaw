/**
 * 钉钉消息流状态管理
 *
 * 职责：
 * - 管理每个钉钉账号的运行状态
 * - 存储 AbortController 用于优雅停止消息流
 * - 提供测试工具函数
 *
 * 核心功能：
 * - setDingtalkMonitorState: 设置账号运行状态
 * - getDingtalkMonitorState: 获取账号运行状态
 * - stopDingtalkMonitorState: 停止单个或多个账号的消息流
 * - 测试工具：clearDingtalkWebhookRateLimitStateForTest 等
 */
const monitorState = new Map<string, { running: boolean; abortController?: AbortController }>();

export function setDingtalkMonitorState(
  accountId: string,
  state: { running: boolean; abortController?: AbortController },
): void {
  monitorState.set(accountId, state);
}

export function getDingtalkMonitorState(
  accountId: string,
): { running: boolean; abortController?: AbortController } | undefined {
  return monitorState.get(accountId);
}

export function stopDingtalkMonitorState(accountId?: string): void {
  if (accountId) {
    const state = monitorState.get(accountId);
    if (state?.abortController) {
      state.abortController.abort();
    }
    monitorState.delete(accountId);
  } else {
    // Stop all monitors
    for (const [id, state] of monitorState.entries()) {
      if (state.abortController) {
        state.abortController.abort();
      }
    }
    monitorState.clear();
  }
}

// Test utilities
export function clearDingtalkWebhookRateLimitStateForTest(): void {
  // DingTalk doesn't use webhook rate limiting
}

export function getDingtalkWebhookRateLimitStateSizeForTest(): number {
  return 0;
}

export function isWebhookRateLimitedForTest(): boolean {
  return false;
}
