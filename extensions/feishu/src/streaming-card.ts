/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { getFeishuUserAgent } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { readFeishuJsonResponse } from "./json-response.js";
import { resolveFeishuCardTemplate } from "./native-card.js";
import type { CardHeaderConfig } from "./send.js";
import { resolveStreamingCardSendMode } from "./streaming-card-send-mode.js";
import {
  assertSuccessfulCardKitResponse,
  cancelUnreadResponseBody,
  getToken,
  resolveAllowedHostnames,
  resolveApiBase,
  type Credentials,
  type FeishuStreamingDeps,
  type FeishuStreamingFetch,
  shouldPushStreamingUpdate,
  STREAMING_UPDATE_THROTTLE_MS,
  truncateSummary,
} from "./streaming-card-wire.js";

export { mergeStreamingText } from "./streaming-card-wire.js";
export type { FeishuStreamingDeps, FeishuStreamingFetch } from "./streaming-card-wire.js";

type CardState = {
  cardId: string;
  messageId?: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
};

type FeishuStreamingCloseResult = {
  visibleReplySent: boolean;
  content?: string;
  messageId?: string;
};

/** Provider finalization failed after a streaming card may already be visible. */
export class FeishuStreamingFinalizationError extends Error {
  readonly result: FeishuStreamingCloseResult;

  constructor(cause: unknown, result: FeishuStreamingCloseResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FeishuStreamingFinalizationError";
    this.result = result;
  }
}

/** Options for customising the initial streaming card appearance. */
type StreamingCardOptions = {
  /** Optional header with title and color template. */
  header?: CardHeaderConfig;
  /** Optional grey note footer text. */
  note?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: CardHeaderConfig;
};

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  // Resolves with confirmed transport acceptance once a flush cycle attempts
  // the exact text; publication caching upstream must never advance on a
  // write the card API rejected.
  private contentFlushWaiters: Array<{ text: string; resolve: (ok: boolean) => void }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private updateThrottleMs = STREAMING_UPDATE_THROTTLE_MS;
  private fetchImpl?: FeishuStreamingFetch;
  private lookupFn?: LookupFn;

  constructor(
    client: Client,
    creds: Credentials,
    log?: (msg: string) => void,
    deps?: FeishuStreamingDeps,
  ) {
    this.client = client;
    this.creds = creds;
    this.log = log;
    this.fetchImpl = deps?.fetchImpl;
    this.lookupFn = deps?.lookupFn;
  }

  private async requestCardKit<T>(
    path: string,
    operation: string,
    method: "POST" | "PUT" | "PATCH",
    body: () => Record<string, unknown>,
    readResponse: (response: Response, auditContext: string) => Promise<T>,
    token?: string,
  ): Promise<T> {
    const auditContext = `feishu.streaming-card.${operation}`;
    const { response, release } = await fetchWithSsrFGuard({
      url: `${resolveApiBase(this.creds.domain)}/cardkit/v1/cards${path}`,
      init: {
        method,
        headers: {
          Authorization: `Bearer ${
            token ??
            (await getToken(this.creds, {
              fetchImpl: this.fetchImpl,
              lookupFn: this.lookupFn,
            }))
          }`,
          "Content-Type":
            method === "PATCH" ? "application/json; charset=utf-8" : "application/json",
          "User-Agent": getFeishuUserAgent(),
        },
        // Token renewal can await; read the current sequence only at dispatch.
        body: JSON.stringify(body()),
      },
      fetchImpl: this.fetchImpl,
      lookupFn: this.lookupFn,
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext,
      timeoutMs: this.creds.httpTimeoutMs ?? FEISHU_HTTP_TIMEOUT_MS,
    });
    try {
      return await readResponse(response, auditContext);
    } finally {
      await release();
    }
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const elements: Record<string, unknown>[] = [
      { tag: "markdown", content: "", element_id: "content" },
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note",
      });
    }
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: { elements },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
      };
    }

    const createData = await this.requestCardKit(
      "",
      "create",
      "POST",
      () => ({ type: "card_json", data: JSON.stringify(cardJson) }),
      async (response, auditContext) => {
        if (!response.ok) {
          cancelUnreadResponseBody(response);
          throw new Error(`Create card request failed with HTTP ${response.status}`);
        }
        return await readFeishuJsonResponse<{
          code: number;
          msg: string;
          data?: { card_id: string };
        }>(response, auditContext);
      },
    );
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await requestFeishuApi(
        () =>
          this.client.im.message.reply({
            path: { message_id: sendOptions.replyToMessageId! },
            data: {
              msg_type: "interactive",
              content: cardContent,
              ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
            },
          }),
        "Send card failed",
      );
    } else {
      sendRes = await requestFeishuApi(
        () =>
          this.client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: receiveId,
              msg_type: "interactive",
              content: cardContent,
              // The SDK omits root_id from its types, but Feishu accepts it at runtime.
              ...(sendMode === "root_create" ? { root_id: sendOptions.rootId } : {}),
            },
          }),
        "Send card failed",
      );
    }
    if (sendRes.code !== 0) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    const messageId = sendRes.data?.message_id?.trim();
    this.state = {
      cardId,
      ...(messageId ? { messageId } : {}),
      sequence: 1,
      currentText: "",
      sentText: "",
      hasNote: Boolean(options?.note),
    };
    this.log?.(`Started streaming: cardId=${cardId}${messageId ? `, messageId=${messageId}` : ""}`);
  }

  private async writeCardContent(
    text: string,
    replace: boolean,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    this.state.sequence += 1;
    try {
      await this.requestCardKit(
        `/${this.state.cardId}/elements/content${replace ? "" : "/content"}`,
        replace ? "replace" : "update",
        "PUT",
        () => ({
          ...(replace
            ? { element: JSON.stringify({ tag: "markdown", content: text, element_id: "content" }) }
            : { content: text }),
          sequence: this.state!.sequence,
          uuid: `${replace ? "r" : "s"}_${this.state!.cardId}_${this.state!.sequence}`,
        }),
        (response, auditContext) =>
          assertSuccessfulCardKitResponse(
            response,
            auditContext,
            replace ? "Replace card content" : "Update card content",
          ),
      );
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private schedulePendingFlush(): void {
    if (this.flushTimer || !this.pendingText || this.closed) {
      return;
    }
    const delayMs = Math.max(0, this.updateThrottleMs - (Date.now() - this.lastUpdateTime));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.pendingText || this.closed) {
        return;
      }
      this.lastUpdateTime = Date.now();
      void this.flushPendingUpdate().catch((error: unknown) =>
        this.log?.(`Scheduled flush update failed: ${String(error)}`),
      );
    }, delayMs);
  }

  private async flushPendingUpdate(): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        if (!this.state || this.closed) {
          return;
        }
        const nextText = this.pendingText;
        if (!nextText) {
          return;
        }
        this.pendingText = null;
        if (nextText === this.state.sentText) {
          return;
        }
        const sent = await this.writeCardContent(nextText, false, (e) =>
          this.log?.(`Update failed: ${String(e)}`),
        );
        if (sent && this.state) {
          this.state.sentText = nextText;
        } else if (!sent && this.state && !this.closed) {
          // A rejected write must not lose the text: keep it pending so the
          // next update retries it. Retries stay caller-driven — a rejected
          // write self-rescheduling here would retry-loop against an outage.
          this.pendingText = this.pendingText ?? nextText;
        }
      } finally {
        this.settleContentFlushWaiters();
      }
    });
    await this.queue;
  }

  private settleContentFlushWaiters(): void {
    const sentText = this.state?.sentText ?? "";
    for (const waiter of this.contentFlushWaiters.splice(0)) {
      waiter.resolve(this.closed ? false : sentText === waiter.text);
    }
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed || !text) {
      return;
    }
    // The caller supplies the complete current card text. CardKit derives its own
    // display delta, so merging snapshots here can duplicate divergent reasoning.
    this.state.currentText = text;
    this.pendingText = text;
    this.clearFlushTimer();

    const shouldForceUpdate = shouldPushStreamingUpdate(this.state.sentText, text);
    const now = Date.now();
    if (!shouldForceUpdate && now - this.lastUpdateTime < this.updateThrottleMs) {
      this.schedulePendingFlush();
      return;
    }
    this.lastUpdateTime = now;
    await this.flushPendingUpdate();
  }

  // Parks a waiter for an upcoming write of `text` and resolves with the
  // transport outcome of the flush cycle that attempts it: rejected writes
  // report false so publication caching upstream (the progress-draft
  // compositor) keeps the draft unacknowledged, superseded snapshots resolve
  // false for the same reason. Callers register BEFORE update() — an
  // immediate rejected attempt settles observers inside update() and never
  // schedules another cycle, so a later registration could never settle.
  registerContentObserver(text: string): Promise<boolean> {
    if (!this.state || this.closed) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.contentFlushWaiters.push({ text, resolve });
    });
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    this.state.sequence += 1;
    const path = `/${this.state.cardId}/elements/note/content`;
    // Token failures propagate; only the note request itself is best effort.
    const token = await getToken(this.creds, {
      fetchImpl: this.fetchImpl,
      lookupFn: this.lookupFn,
    });
    await this.requestCardKit(
      path,
      "note-update",
      "PUT",
      () => ({
        content: `<font color='grey'>${note}</font>`,
        sequence: this.state!.sequence,
        uuid: `n_${this.state!.cardId}_${this.state!.sequence}`,
      }),
      (response, auditContext) =>
        assertSuccessfulCardKitResponse(response, auditContext, "Update card note"),
      token,
    ).catch((e: unknown) => this.log?.(`Note update failed: ${String(e)}`));
  }

  async closeWithResult(
    finalText?: string,
    options?: { note?: string },
  ): Promise<FeishuStreamingCloseResult> {
    if (!this.state || this.closed) {
      return { visibleReplySent: false };
    }
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;
    this.settleContentFlushWaiters();

    const text = finalText ?? this.pendingText ?? this.state.currentText;
    // A failed final rewrite does not erase previously accepted visible content.
    // sentText advances only for an accepted write; the return value reports any visible content.
    let visibleContentSent = Boolean(this.state.sentText.trim());
    let finalWriteError: unknown;

    // Only send final update if content differs from what's already displayed.
    // An explicit empty final text clears a transient preview before closeout.
    if ((text || finalText !== undefined) && text !== this.state.sentText) {
      const replace = !text.startsWith(this.state.sentText);
      const sent = await this.writeCardContent(text, replace, (e) => {
        finalWriteError = e;
        this.log?.(`Final ${replace ? "replace" : "update"} failed: ${String(e)}`);
      });
      this.state.currentText = text;
      if (sent) {
        this.state.sentText = text;
        visibleContentSent = Boolean(text.trim());
      }
    }

    // Update note with final model/provider info
    if (options?.note) {
      await this.updateNoteContent(options.note);
    }

    // Close streaming mode
    // A rejected final write must not advertise content that CardKit never accepted.
    const acceptedText = this.state.sentText;
    this.state.sequence += 1;
    let closeError: unknown;
    try {
      await this.requestCardKit(
        `/${this.state.cardId}/settings`,
        "close",
        "PATCH",
        () => ({
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: truncateSummary(acceptedText) },
            },
          }),
          sequence: this.state!.sequence,
          uuid: `c_${this.state!.cardId}_${this.state!.sequence}`,
        }),
        (response, auditContext) =>
          assertSuccessfulCardKitResponse(response, auditContext, "Close streaming card"),
      );
    } catch (error: unknown) {
      closeError = error;
      this.log?.(`Close failed: ${String(error)}`);
    }
    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
    const result: FeishuStreamingCloseResult = {
      visibleReplySent: visibleContentSent,
      ...(visibleContentSent ? { content: finalState.sentText } : {}),
      ...(finalState.messageId ? { messageId: finalState.messageId } : {}),
    };
    if (finalWriteError !== undefined || closeError !== undefined) {
      const cause =
        finalWriteError !== undefined && closeError !== undefined
          ? new AggregateError(
              [finalWriteError, closeError],
              "Feishu streaming card finalization failed",
            )
          : (finalWriteError ?? closeError);
      throw new FeishuStreamingFinalizationError(cause, result);
    }
    return result;
  }

  async discard(): Promise<FeishuStreamingCloseResult> {
    if (!this.state || this.closed) {
      return { visibleReplySent: false };
    }
    const { cardId, messageId } = this.state;
    if (!messageId) {
      // Accepted cards without a message receipt can still be cleared by card id.
      return this.closeWithResult("");
    }
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;
    this.settleContentFlushWaiters();

    try {
      const response = await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Delete streaming card message failed: ${response.msg ?? response.code}`);
      }
      this.state = null;
      this.pendingText = null;
      this.log?.(`Discarded streaming card: cardId=${cardId}`);
      return { visibleReplySent: false };
    } catch (error) {
      this.log?.(`Discard failed: ${String(error)}`);
      this.closed = false;
      // A rejected clear leaves accepted text visible; preserve its receipt and failure.
      return this.closeWithResult("");
    }
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
