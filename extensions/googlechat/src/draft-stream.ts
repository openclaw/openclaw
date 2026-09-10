// Googlechat plugin module implements a live-updating status draft stream.
//
// "live" typing mode reuses the typing placeholder message and edits it in place
// with mid-turn progress (tool started, thinking, ...) through spaces.messages.patch,
// then collapses it into the final reply. It needs only the chat.bot scope; no
// user OAuth.
import {
  createChannelProgressDraftCompositor,
  createDraftStreamLoop,
} from "openclaw/plugin-sdk/channel-outbound";
import type { StreamingMode } from "openclaw/plugin-sdk/channel-outbound";
import type { GoogleChatAccountConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError, sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";

// Chat's PATCH quota (spaces.messages.patch) is stricter than Slack's edit
// quota, so hold a longer minimum interval between edits than the shared 1000ms
// draft default to stay well under the per-space write ceiling on busy turns.
const GOOGLECHAT_DRAFT_THROTTLE_MS = 1500;

export type GoogleChatDraftStream = {
  /** Wire these into the turn's replyOptions callbacks. */
  pushToolEvent: ReturnType<typeof createChannelProgressDraftCompositor>["pushToolEvent"];
  pushItemEvent: ReturnType<typeof createChannelProgressDraftCompositor>["pushItemEvent"];
  pushReasoningProgress: ReturnType<
    typeof createChannelProgressDraftCompositor
  >["pushReasoningProgress"];
  /** The message name currently edited; may change after a 404 re-send. */
  messageName: () => string;
  /** The thread the message now lives in; may change after a 404 re-send. */
  deliveredThreadName: () => string | undefined;
  /**
   * Stop progress edits, flush the last in-flight one, then PATCH the message to
   * the final reply text. Stopping before the final PATCH keeps a late progress
   * edit from clobbering the final answer.
   */
  finalize: (finalText: string) => Promise<void>;
  /** Stop the loop without a final edit (used on cleanup paths). */
  stop: () => Promise<void>;
};

export function createGoogleChatDraftStream(params: {
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  /** Typing placeholder message name to edit in place. */
  messageName: string;
  /** Thread the placeholder was delivered on, kept for the 404 re-send path. */
  threadName?: string;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
}): GoogleChatDraftStream {
  const { account, spaceId, threadName, runtime } = params;
  let messageName = params.messageName.trim();
  // Tracks the thread a 404 re-send landed in, so final delivery can follow the
  // replacement thread instead of the original placeholder's.
  let deliveredThreadName = threadName;
  let stopped = false;

  // Edit the placeholder in place. A 404 means the message was deleted out from
  // under us; re-send a fresh one and adopt its name, mirroring the reply
  // delivery fallback.
  const editMessage = async (text: string): Promise<boolean> => {
    if (!text.trim()) {
      return false;
    }
    try {
      await updateGoogleChatMessage({ account, messageName, text });
      return true;
    } catch (error) {
      if (!(error instanceof GoogleChatApiError) || error.status !== 404) {
        runtime.error?.(`Google Chat live status edit failed: ${String(error)}`);
        return false;
      }
      runtime.error?.(`Google Chat live status message gone; re-sending: ${String(error)}`);
      try {
        const sent = await sendGoogleChatMessage({
          account,
          space: spaceId,
          text,
          thread: threadName,
        });
        if (sent?.messageName) {
          messageName = sent.messageName;
          deliveredThreadName = sent.threadName ?? deliveredThreadName;
          return true;
        }
      } catch (resendError) {
        runtime.error?.(`Google Chat live status re-send failed: ${String(resendError)}`);
      }
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs: GOOGLECHAT_DRAFT_THROTTLE_MS,
    coalesceInFlight: true,
    isStopped: () => stopped,
    sendOrEditStreamMessage: editMessage,
    onBackgroundFlushError: (err) => {
      runtime.error?.(`Google Chat live status flush failed: ${String(err)}`);
    },
  });

  const compositor = createChannelProgressDraftCompositor({
    // SAFETY: account.config is the resolved GoogleChatAccountConfig for this account.
    entry: account.config as GoogleChatAccountConfig,
    mode: "progress" satisfies StreamingMode,
    active: true,
    seed: `${account.accountId}:${spaceId}`,
    update: (text) => {
      loop.update(text);
    },
  });

  const finalize = async (finalText: string): Promise<void> => {
    // Stop the loop and drain its in-flight edit BEFORE the final PATCH so a late
    // progress edit cannot land after the final answer.
    compositor.markFinalReplyStarted();
    loop.stop();
    await loop.waitForInFlight();
    stopped = true;
    const text = finalText.trim();
    if (!text) {
      return;
    }
    await editMessage(text);
    compositor.markFinalReplyDelivered();
  };

  const stop = async (): Promise<void> => {
    compositor.markFinalReplyStarted();
    loop.stop();
    await loop.waitForInFlight();
    stopped = true;
  };

  return {
    pushToolEvent: (...args) => compositor.pushToolEvent(...args),
    pushItemEvent: (...args) => compositor.pushItemEvent(...args),
    pushReasoningProgress: (...args) => compositor.pushReasoningProgress(...args),
    messageName: () => messageName,
    deliveredThreadName: () => deliveredThreadName,
    finalize,
    stop,
  };
}
