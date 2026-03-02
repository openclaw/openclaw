import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import type { MatrixSendResult } from "./send.js";

const CURSOR = " \u258c";
const DEFAULT_THROTTLE_MS = 800;

export type MatrixDraftStream = {
  update: (text: string) => void;
  /** Cancel pending timer, discard pending text, and drain any in-flight send before returning. */
  stop: () => Promise<void>;
  finalize: () => Promise<string | null>;
  forceNewMessage: () => void;
  getEventId: () => string | null;
};

export function createMatrixDraftStream(params: {
  roomId: string;
  accountId?: string;
  threadId?: string | null;
  replyToId?: string;
  throttleMs?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  _send?: typeof sendMessageMatrix;
  _edit?: typeof editMessageMatrix;
}): MatrixDraftStream {
  const throttleMs = params.throttleMs ?? DEFAULT_THROTTLE_MS;
  const send = params._send ?? sendMessageMatrix;
  const edit = params._edit ?? editMessageMatrix;

  let eventId: string | null = null;
  // lastSentText tracks the text (without cursor) that was last sent, for dedup
  let lastSentText: string | null = null;

  // Throttle state: initialize to now so the first update always goes through schedule()
  // rather than firing immediately (avoids sending "a ▌" before updates coalesce).
  let lastSentAt = Date.now();
  // pendingText stores the user-visible text (without cursor); null means nothing pending
  let pendingText: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Send or edit the stream message. `withCursor` controls whether the cursor is appended.
  async function sendOrEdit(text: string, withCursor: boolean): Promise<void> {
    const wire = withCursor ? text + CURSOR : text;
    // Skip if same text (with same cursor state)
    if (wire === lastSentText) {
      return;
    }
    const prevSentText = lastSentText;
    try {
      let result: MatrixSendResult;
      if (eventId === null) {
        result = await send(params.roomId, wire, {
          accountId: params.accountId,
          threadId: params.threadId,
          replyToId: params.replyToId,
        });
        eventId = result.messageId;
      } else {
        result = await edit(params.roomId, eventId, wire, {
          accountId: params.accountId,
        });
      }
      // Only mark as sent after successful network call so transient failures
      // don't prevent retries (the dedup check compares against lastSentText).
      lastSentText = wire;
    } catch (err) {
      // Reset to previous value so the same text can be retried on next update.
      lastSentText = prevSentText;
      params.warn?.(
        `matrix draft stream error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) {
      await inFlight;
      if (pendingText !== null) {
        await flush();
      }
      return;
    }
    const text = pendingText;
    if (text === null) {
      return;
    }
    pendingText = null;
    inFlight = sendOrEdit(text, true).finally(() => {
      inFlight = null;
      lastSentAt = Date.now();
    });
    await inFlight;
    if (pendingText !== null) {
      await flush();
    }
  }

  function schedule(): void {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  }

  function update(text: string): void {
    if (stopped) return;
    pendingText = text;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  }

  async function finalize(): Promise<string | null> {
    // If no update was ever called (nothing pending, nothing sent), return null
    if (pendingText === null && lastSentText === null) {
      return null;
    }

    // Flush any pending text (with cursor) if it's queued
    if (pendingText !== null) {
      await flush();
    }

    // Wait for any in-flight send to complete
    if (inFlight) {
      await inFlight;
    }

    if (eventId === null) {
      return null;
    }

    // Determine the final text (without cursor): strip cursor from lastSentText if present
    const finalText =
      lastSentText !== null && lastSentText.endsWith(CURSOR)
        ? lastSentText.slice(0, -CURSOR.length)
        : (lastSentText ?? "");

    // Force-send the final edit without cursor by temporarily clearing lastSentText
    // so the dedup check doesn't prevent the final send
    lastSentText = null;
    await sendOrEdit(finalText, false);

    return eventId;
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Discard any pending text so flush() won't loop after inFlight completes
    pendingText = null;
    // Wait for any in-flight cursor edit to finish before the caller sends the final edit.
    // Without this, deliver's editMessageMatrix and the in-flight sendOrEdit race on
    // Synapse, and whichever arrives last wins — potentially leaving the cursor in the message.
    if (inFlight) {
      await inFlight;
    }
  }

  function forceNewMessage(): void {
    eventId = null;
    lastSentText = null;
    pendingText = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getEventId(): string | null {
    return eventId;
  }

  return { update, stop, finalize, forceNewMessage, getEventId };
}
