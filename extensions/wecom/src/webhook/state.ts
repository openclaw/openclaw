/**
 * Webhook mode state management
 *
 * Fully migrated from @mocrane/wecom monitor/state.ts.
 * Contains StreamStore (stream state storage), ActiveReplyStore (active reply URL storage), MonitorState (global container).
 */

import crypto from "node:crypto";
import type {
  StreamState,
  PendingInbound,
  ActiveReplyState,
  WecomWebhookTarget,
  WebhookInboundMessage,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

export const LIMITS = {
  STREAM_TTL_MS: 10 * 60 * 1000,
  ACTIVE_REPLY_TTL_MS: 60 * 60 * 1000,
  DEFAULT_DEBOUNCE_MS: 500,
  STREAM_MAX_BYTES: 20_480,
  REQUEST_TIMEOUT_MS: 15_000,
};

// ============================================================================
// StreamStore
// ============================================================================

/**
 * **StreamStore (stream state session storage)**
 *
 * Manages streaming session state, message deduplication, and debounce aggregation logic for WeCom callbacks.
 * Maintains msgid-to-streamId mapping and temporarily caches pending messages.
 */
export class StreamStore {
  private streams = new Map<string, StreamState>();
  private msgidToStreamId = new Map<string, string>();
  private pendingInbounds = new Map<string, PendingInbound>();
  private conversationState = new Map<
    string,
    { activeBatchKey: string; queue: string[]; nextSeq: number }
  >();
  private streamIdToBatchKey = new Map<string, string>();
  private batchStreamIdToAckStreamIds = new Map<string, string[]>();
  private onFlush?: (pending: PendingInbound) => void;

  /**
   * **setFlushHandler (set debounce flush callback)**
   *
   * Handler called when the debounce timer expires. Typically used to trigger Agent message processing.
   * @param handler Callback function that receives the aggregated PendingInbound object
   */
  public setFlushHandler(handler: (pending: PendingInbound) => void): void {
    this.onFlush = handler;
  }

  /**
   * **createStream (create stream session)**
   *
   * Initialize a new streaming session state.
   * @param params.msgid (optional) WeCom message ID for subsequent deduplication mapping
   * @returns Generated streamId (hex string)
   */
  createStream(params: { msgid?: string; conversationKey?: string; batchKey?: string }): string {
    const streamId = crypto.randomBytes(16).toString("hex");

    if (params.msgid) {
      this.msgidToStreamId.set(String(params.msgid), streamId);
    }

    this.streams.set(streamId, {
      streamId,
      msgid: params.msgid,
      conversationKey: params.conversationKey,
      batchKey: params.batchKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      started: false,
      finished: false,
      content: "",
    });

    if (params.batchKey) {
      this.streamIdToBatchKey.set(streamId, params.batchKey);
    }

    return streamId;
  }

  /**
   * **getStream (get stream state)**
   *
   * Get the current session state by streamId.
   * @param streamId Stream session ID
   */
  getStream(streamId: string): StreamState | undefined {
    return this.streams.get(streamId);
  }

  /**
   * **getStreamByMsgId (find stream ID by msgid)**
   *
   * Used for message deduplication: check if this msgid is already associated with an in-progress or completed stream session.
   * @param msgid WeCom message ID
   */
  getStreamByMsgId(msgid: string): string | undefined {
    return this.msgidToStreamId.get(String(msgid));
  }

  /** Manually set msgid → streamId mapping */
  setStreamIdForMsgId(msgid: string, streamId: string): void {
    const key = String(msgid).trim();
    const value = String(streamId).trim();
    if (!key || !value) {
      return;
    }
    this.msgidToStreamId.set(key, value);
  }

  /**
   * Associate an "ack stream" with a "batch stream".
   * Used so that when multiple user messages are merged and queued, later message streams can still be updated with a meaningful status instead of staying forever at "merged and queued...".
   */
  addAckStreamForBatch(params: { batchStreamId: string; ackStreamId: string }): void {
    const batchStreamId = params.batchStreamId.trim();
    const ackStreamId = params.ackStreamId.trim();
    if (!batchStreamId || !ackStreamId) {
      return;
    }
    const list = this.batchStreamIdToAckStreamIds.get(batchStreamId) ?? [];
    list.push(ackStreamId);
    this.batchStreamIdToAckStreamIds.set(batchStreamId, list);
  }

  /**
   * Retrieve and clear all ack streams associated with a batch stream.
   */
  drainAckStreamsForBatch(batchStreamId: string): string[] {
    const key = batchStreamId.trim();
    if (!key) {
      return [];
    }
    const list = this.batchStreamIdToAckStreamIds.get(key) ?? [];
    this.batchStreamIdToAckStreamIds.delete(key);
    return list;
  }

  /**
   * **updateStream (update stream state)**
   *
   * Atomically update the stream state and automatically refresh the updatedAt timestamp.
   * @param streamId Stream session ID
   * @param mutator State mutation function
   */
  updateStream(streamId: string, mutator: (state: StreamState) => void): void {
    const state = this.streams.get(streamId);
    if (state) {
      mutator(state);
      state.updatedAt = Date.now();
    }
  }

  /**
   * **markStarted (mark stream as started)**
   *
   * Mark the stream session as having started processing (typically called after the Agent starts).
   */
  markStarted(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.started = true;
    });
  }

  /**
   * **markFinished (mark stream as finished)**
   *
   * Mark the stream session as completed so it no longer receives content updates.
   */
  markFinished(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.finished = true;
    });
  }

  /**
   * **addPendingMessage (add pending message / debounce aggregation)**
   *
   * Add a received message to the pending queue. If the same pendingKey already exists, it is merged by debounce aggregation; otherwise a new entry is created.
   * The debounce timer is automatically set or reset.
   *
   * @param params Message parameters
   * @returns { streamId, isNew } isNew=true indicates this is a new message group and ActiveReply must be initialized
   */
  addPendingMessage(params: {
    conversationKey: string;
    target: WecomWebhookTarget;
    msg: WebhookInboundMessage;
    msgContent: string;
    nonce: string;
    timestamp: string;
    debounceMs?: number;
  }): {
    streamId: string;
    status: "active_new" | "active_merged" | "queued_new" | "queued_merged";
  } {
    const { conversationKey, target, msg, msgContent, nonce, timestamp, debounceMs } = params;
    const effectiveDebounceMs = debounceMs ?? LIMITS.DEFAULT_DEBOUNCE_MS;

    const state = this.conversationState.get(conversationKey);
    if (!state) {
      // Initial batch (active)
      const batchKey = conversationKey;
      const streamId = this.createStream({ msgid: msg.msgid, conversationKey, batchKey });
      const pending: PendingInbound = {
        streamId,
        conversationKey,
        batchKey,
        target,
        msg,
        contents: [msgContent],
        msgids: msg.msgid ? [msg.msgid] : [],
        nonce,
        timestamp,
        createdAt: Date.now(),
        timeout: setTimeout(() => {
          this.requestFlush(batchKey);
        }, effectiveDebounceMs),
      };
      this.pendingInbounds.set(batchKey, pending);
      this.conversationState.set(conversationKey, {
        activeBatchKey: batchKey,
        queue: [],
        nextSeq: 1,
      });
      return { streamId, status: "active_new" };
    }

    // Merge rules (queuing semantics):
    // - The initial batch (batchKey===conversationKey) does not accept merges, to avoid both 1 and 2 showing the same final answer.
    // - If the active batch is a "queued batch" (batchKey!=conversationKey) and has not started processing yet (started=false),
    //   then later messages may be merged into that active batch (typical case: 1 finishes quickly, 2 becomes active but has not started yet, and 3 merges into 2).
    const activeBatchKey = state.activeBatchKey;
    const activeIsInitial = activeBatchKey === conversationKey;
    const activePending = this.pendingInbounds.get(activeBatchKey);
    if (activePending && !activeIsInitial) {
      const activeStream = this.streams.get(activePending.streamId);
      const activeStarted = Boolean(activeStream?.started);
      if (!activeStarted) {
        activePending.contents.push(msgContent);
        if (msg.msgid) {
          activePending.msgids.push(msg.msgid);
          // Note: do not map this msgid to the active streamId, to avoid this message also showing the same full final answer
        }
        if (activePending.timeout) {
          clearTimeout(activePending.timeout);
        }
        activePending.timeout = setTimeout(() => {
          this.requestFlush(activeBatchKey);
        }, effectiveDebounceMs);
        return { streamId: activePending.streamId, status: "active_merged" };
      }
    }

    // The active batch has already started processing; later messages go into the queued batch and may be debounce-aggregated within that queued batch.
    const queuedBatchKey = state.queue[0];
    if (queuedBatchKey) {
      const existingQueued = this.pendingInbounds.get(queuedBatchKey);
      if (existingQueued) {
        existingQueued.contents.push(msgContent);
        if (msg.msgid) {
          existingQueued.msgids.push(msg.msgid);
          // Note: do not map this msgid to the queued streamId, to avoid this message also showing the same full final answer
        }
        if (existingQueued.timeout) {
          clearTimeout(existingQueued.timeout);
        }

        existingQueued.timeout = setTimeout(() => {
          this.requestFlush(queuedBatchKey);
        }, effectiveDebounceMs);
        return { streamId: existingQueued.streamId, status: "queued_merged" };
      }
    }

    // Create a new queued batch (the conversation keeps only one "next batch", and later messages continue merging into that batch)
    const seq = state.nextSeq++;
    const batchKey = `${conversationKey}#q${seq}`;
    state.queue = [batchKey];
    const streamId = this.createStream({ msgid: msg.msgid, conversationKey, batchKey });
    const pending: PendingInbound = {
      streamId,
      conversationKey,
      batchKey,
      target,
      msg,
      contents: [msgContent],
      msgids: msg.msgid ? [msg.msgid] : [],
      nonce,
      timestamp,
      createdAt: Date.now(),
      timeout: setTimeout(() => {
        this.requestFlush(batchKey);
      }, effectiveDebounceMs),
    };
    this.pendingInbounds.set(batchKey, pending);
    this.conversationState.set(conversationKey, state);
    return { streamId, status: "queued_new" };
  }

  /**
   * 请求刷新：如果该批次当前为 active，则立即 flush；否则标记 ready，等待前序批次完成后再 flush。
   */
  private requestFlush(batchKey: string): void {
    const pending = this.pendingInbounds.get(batchKey);
    if (!pending) {
      return;
    }

    const state = this.conversationState.get(pending.conversationKey);
    const isActive = state?.activeBatchKey === batchKey;
    if (!isActive) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      pending.readyToFlush = true;
      return;
    }
    this.flushPending(batchKey);
  }

  /**
   * **flushPending (触发消息处理)**
   *
   * 内部方法：防抖时间结束后，将聚合的消息一次性推送给 flushHandler。
   */
  private flushPending(pendingKey: string): void {
    const pending = this.pendingInbounds.get(pendingKey);
    if (!pending) {
      return;
    }

    this.pendingInbounds.delete(pendingKey);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    pending.readyToFlush = false;

    if (this.onFlush) {
      this.onFlush(pending);
    }
  }

  /**
   * 在一个 stream 完成后推进会话队列：将 queued 批次提升为 active，并在需要时触发 flush。
   */
  onStreamFinished(streamId: string): void {
    const batchKey = this.streamIdToBatchKey.get(streamId);
    const state = batchKey ? this.streams.get(streamId) : undefined;
    const conversationKey = state?.conversationKey;
    if (!batchKey || !conversationKey) {
      return;
    }

    const conv = this.conversationState.get(conversationKey);
    if (!conv) {
      return;
    }
    if (conv.activeBatchKey !== batchKey) {
      return;
    }

    const next = conv.queue.shift();
    if (!next) {
      // 队列为空：会话已空闲。删除状态，避免后续消息被误判为“排队但永远不触发”。
      this.conversationState.delete(conversationKey);
      return;
    }
    conv.activeBatchKey = next;
    this.conversationState.set(conversationKey, conv);

    const pending = this.pendingInbounds.get(next);
    if (!pending) {
      return;
    }
    if (pending.readyToFlush) {
      this.flushPending(next);
    }
    // 否则等待该批次自己的 debounce timer 到期后 requestFlush(next) 执行
  }

  /**
   * **prune (清理过期状态)**
   *
   * 清理过期的流会话、msgid 映射以及残留的 Pending 消息。
   * @param now 当前时间戳 (毫秒)
   */
  prune(now: number = Date.now()): void {
    const streamCutoff = now - LIMITS.STREAM_TTL_MS;

    // Clean up expired stream sessions
    for (const [id, state] of this.streams.entries()) {
      if (state.updatedAt < streamCutoff) {
        this.streams.delete(id);
        // Remove stale batch-key mapping so conversationState can be released
        this.streamIdToBatchKey.delete(id);
        if (state.msgid) {
          if (this.msgidToStreamId.get(state.msgid) === id) {
            this.msgidToStreamId.delete(state.msgid);
          }
        }
      }
    }

    // Clean up dangling msgid mappings (double check)
    for (const [msgid, id] of this.msgidToStreamId.entries()) {
      if (!this.streams.has(id)) {
        this.msgidToStreamId.delete(msgid);
      }
    }

    // Clean up dangling streamIdToBatchKey mappings (streams already removed)
    for (const [sid] of this.streamIdToBatchKey.entries()) {
      if (!this.streams.has(sid)) {
        this.streamIdToBatchKey.delete(sid);
      }
    }

    // 清理超时的 Pending 消息 (通常由 timeout 清理，此处作为兜底)
    for (const [key, pending] of this.pendingInbounds.entries()) {
      if (now - pending.createdAt > LIMITS.STREAM_TTL_MS) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        this.pendingInbounds.delete(key);
      }
    }

    // 清理 conversationState：active 已不存在且队列为空的会话
    for (const [convKey, conv] of this.conversationState.entries()) {
      const activeExists =
        this.pendingInbounds.has(conv.activeBatchKey) ||
        Array.from(this.streamIdToBatchKey.values()).includes(conv.activeBatchKey);
      const hasQueue = conv.queue.length > 0;
      if (!activeExists && !hasQueue) {
        this.conversationState.delete(convKey);
      }
    }
  }
}

/**
 * **ActiveReplyStore (主动回复地址存储)**
 *
 * 管理企业微信回调中的 `response_url` (用于被动回复转主动推送) 和 `proxyUrl`。
 * 支持 'once' (一次性) 或 'multi' (多次) 使用策略。
 */
export class ActiveReplyStore {
  private activeReplies = new Map<string, ActiveReplyState>();

  /**
   * @param policy 使用策略: "once" (默认，销毁式) 或 "multi"
   */
  constructor(private policy: "once" | "multi" = "once") {}

  /**
   * **store (存储回复地址)**
   *
   * 关联 streamId 与 response_url。
   */
  store(streamId: string, responseUrl?: string, proxyUrl?: string): void {
    const url = responseUrl?.trim();
    if (!url) {
      return;
    }
    this.activeReplies.set(streamId, { response_url: url, proxyUrl, createdAt: Date.now() });
  }

  /**
   * **getUrl (获取回复地址)**
   *
   * 获取指定 streamId 关联的 response_url。
   */
  getUrl(streamId: string): string | undefined {
    return this.activeReplies.get(streamId)?.response_url;
  }

  /**
   * 获取关联的代理 URL
   */
  getProxyUrl(streamId: string): string | undefined {
    return this.activeReplies.get(streamId)?.proxyUrl;
  }

  /**
   * **use (消耗回复地址)**
   *
   * 使用存储的 response_url 执行操作。
   * - 如果策略是 "once"，第二次调用会抛错。
   * - 自动更新使用时间 (usedAt)。
   *
   * @param streamId 流会话 ID
   * @param fn 执行函数，接收 { responseUrl, proxyUrl }
   */
  async use(
    streamId: string,
    fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
  ): Promise<void> {
    const state = this.activeReplies.get(streamId);
    if (!state?.response_url) {
      return; // 无 URL 可用，安全跳过
    }

    if (this.policy === "once" && state.usedAt) {
      throw new Error(`response_url already used for stream ${streamId} (Policy: once)`);
    }

    try {
      await fn({ responseUrl: state.response_url, proxyUrl: state.proxyUrl });
      state.usedAt = Date.now();
    } catch (err: unknown) {
      state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * **prune (清理过期地址)**
   *
   * 清理超过 TTL 的 active reply 记录。
   */
  prune(now: number = Date.now()): void {
    const cutoff = now - LIMITS.ACTIVE_REPLY_TTL_MS;
    for (const [id, state] of this.activeReplies.entries()) {
      if (state.createdAt < cutoff) {
        this.activeReplies.delete(id);
      }
    }
  }
}

/**
 * **MonitorState (全局监控状态容器)**
 *
 * 模块单例，统一管理 StreamStore 和 ActiveReplyStore 实例。
 * 提供生命周期方法 (startPruning / stopPruning) 以自动清理过期数据。
 */
export class WebhookMonitorState {
  /** 主要的流状态存储 */
  public readonly streamStore = new StreamStore();
  /** 主动回复地址存储 */
  public readonly activeReplyStore = new ActiveReplyStore("multi");

  private pruneInterval?: NodeJS.Timeout;

  /**
   * **startPruning (启动自动清理)**
   *
   * 启动定时器，定期清理过期的流和回复地址。应在插件有活跃 Target 时调用。
   * @param intervalMs 清理间隔 (默认 60s)
   */
  public startPruning(intervalMs: number = 60_000): void {
    if (this.pruneInterval) {
      return;
    }
    this.pruneInterval = setInterval(() => {
      const now = Date.now();
      this.streamStore.prune(now);
      this.activeReplyStore.prune(now);
    }, intervalMs);
  }

  /**
   * **stopPruning (停止自动清理)**
   *
   * 停止定时器。应在插件无活跃 Target 时调用以释放资源。
   */
  public stopPruning(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = undefined;
    }
  }
}

/**
 * **monitorState (全局单例)**
 *
 * 导出全局唯一的 MonitorState 实例，供整个应用共享状态。
 */
export const monitorState = new WebhookMonitorState();
