// Feishu plugin module owns reply fallback sequencing.
import { isFeishuMessageAuditRejection, MESSAGE_AUDIT_REJECTION_NOTICE } from "./message-audit.js";

const NO_VISIBLE_REPLY_FALLBACK_TEXT =
  "⚠️ This reply completed without visible content. The turn may have been interrupted; please retry or ask me to recover from recent context.";

type VisibleReplyState = {
  visibleReplySent: boolean;
  skippedFinalReason: string | null;
};

type ReplyFallbackControllerParams = {
  accountId: string;
  closeStreaming: (options?: { markClosedForReply?: boolean }) => Promise<void>;
  getVisibleReplyState: () => VisibleReplyState;
  log?: (message: string) => void;
  error?: (message: string) => void;
  markVisibleReplySent: () => void;
  onIdle: () => void;
  sendText: (text: string) => Promise<void>;
};

export function createFeishuReplyFallbackController(params: ReplyFallbackControllerParams) {
  let messageAuditNoticeQueued = false;
  let idleSideEffectsPromise: Promise<void> = Promise.resolve();

  const queueIdleSideEffects = (options?: { markClosedForReply?: boolean }): Promise<void> => {
    const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
      await params.closeStreaming(options);
      params.onIdle();
    });
    // Observe failures immediately so later queue work can continue; callers still
    // receive the original rejection through the returned task.
    idleSideEffectsPromise = nextIdleSideEffects.catch(() => {});
    return nextIdleSideEffects;
  };

  const queueMessageAuditNotice = (): Promise<void> => {
    // Keep the notice in the idle chain so fallback evaluation cannot race it.
    const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
      try {
        await params.sendText(MESSAGE_AUDIT_REJECTION_NOTICE);
        params.markVisibleReplySent();
      } catch (noticeError) {
        params.error?.(
          `feishu[${params.accountId}]: failed to send message audit rejection notice: ${String(noticeError)}`,
        );
      }
    });
    idleSideEffectsPromise = nextIdleSideEffects;
    return nextIdleSideEffects;
  };

  const handleReplyError = async (error: unknown): Promise<void> => {
    const shouldQueueAuditNotice =
      !messageAuditNoticeQueued && isFeishuMessageAuditRejection(error);
    if (shouldQueueAuditNotice) {
      messageAuditNoticeQueued = true;
    }
    const idleTask = queueIdleSideEffects({ markClosedForReply: false });
    if (shouldQueueAuditNotice) {
      await queueMessageAuditNotice();
      await idleTask;
      return;
    }
    await idleTask;
  };

  const ensureNoVisibleReplyFallback = async (reason: string): Promise<boolean> => {
    await idleSideEffectsPromise;
    const state = params.getVisibleReplyState();
    if (state.visibleReplySent) {
      return false;
    }
    if (state.skippedFinalReason === "silent") {
      params.log?.(
        `feishu[${params.accountId}]: no-visible-reply fallback skipped for intentional silence (${reason})`,
      );
      return false;
    }
    await params.sendText(NO_VISIBLE_REPLY_FALLBACK_TEXT);
    params.markVisibleReplySent();
    params.error?.(`feishu[${params.accountId}]: sent no-visible-reply fallback (${reason})`);
    return true;
  };

  return {
    ensureNoVisibleReplyFallback,
    handleReplyError,
    onIdle: () => queueIdleSideEffects(),
  };
}
