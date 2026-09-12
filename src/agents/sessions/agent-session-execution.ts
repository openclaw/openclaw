import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import type { AssistantMessage } from "../../llm/types.js";
import { isRetryableAssistantError } from "../../llm/utils/retry.js";
import { sleep } from "../../utils/sleep.js";
import { classifyRateLimitWindow } from "../failover/retry-evidence.js";
import { AgentSessionExtensions } from "./agent-session-extensions.js";

export abstract class AgentSessionExecution extends AgentSessionExtensions {
  // =========================================================================
  // Auto-Retry
  // =========================================================================

  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  protected isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) {
      return false;
    }

    // Context overflow is handled by compaction, not retry
    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) {
      return false;
    }

    return isRetryableAssistantError(message);
  }

  /**
   * Prepare a retryable error for continuation with exponential backoff.
   * @returns true if the caller should continue the agent, false otherwise
   */
  protected async prepareRetry(message: AssistantMessage): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return false;
    }

    this.retryCount++;

    if (this.retryCount > settings.maxRetries) {
      // Preserve the completed attempt count so post-run handling can emit the final failure.
      this.retryCount--;
      return false;
    }

    const backoffDelayMs = settings.baseDelayMs * 2 ** (this.retryCount - 1);
    const rateLimitWindow = classifyRateLimitWindow(message.errorMessage);
    const retryAfterDelayMs =
      rateLimitWindow.kind === "short" && rateLimitWindow.retryAfterSeconds !== undefined
        ? Math.ceil(rateLimitWindow.retryAfterSeconds * 1000)
        : 0;
    const delayMs = Math.max(backoffDelayMs, retryAfterDelayMs);

    this.emit({
      type: "auto_retry_start",
      attempt: this.retryCount,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
    });

    // Remove error message from agent state (keep in session for history)
    const messages = this.agent.state.messages;
    if (messages.at(-1)?.role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }

    // Wait with exponential backoff (abortable)
    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      // Aborted during sleep - emit end event so UI can clean up
      const attempt = this.retryCount;
      this.retryCount = 0;
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      return false;
    } finally {
      this.retryAbortController = undefined;
    }

    return true;
  }

  /**
   * Cancel in-progress retry.
   */
  abortRetry(): void {
    this.retryAbortController?.abort();
  }

  /** Whether auto-retry is currently in progress */
  get isRetrying(): boolean {
    return this.retryAbortController !== undefined;
  }

  /** Whether auto-retry is enabled */
  get autoRetryEnabled(): boolean {
    return this.settingsManager.getRetryEnabled();
  }

  /**
   * Toggle auto-retry setting.
   */
  setAutoRetryEnabled(enabled: boolean): void {
    this.settingsManager.setRetryEnabled(enabled);
  }
}
