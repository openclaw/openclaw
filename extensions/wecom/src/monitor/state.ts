import crypto from "node:crypto";
import type { WecomInboundMessage } from "../types.js";
import type { StreamState, PendingInbound, ActiveReplyState, WecomWebhookTarget } from "./types.js";

// Constants
export const LIMITS = {
  STREAM_TTL_MS: 10 * 60 * 1000,
  ACTIVE_REPLY_TTL_MS: 60 * 60 * 1000,
  DEFAULT_DEBOUNCE_MS: 500,
  STREAM_MAX_BYTES: 20_480,
  REQUEST_TIMEOUT_MS: 15_000,
};

/**
 * **StreamStore (流状态会话存储)**
 *
 * 管理企业微信回调的流式会话状态、消息去重和防抖聚合逻辑。
 * 负责维护 msgid 到 streamId 的映射，以及临时缓存待处理的 Pending 消息。
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
   * **setFlushHandler (设置防抖刷新回调)**
   *
   * 当防抖计时器结束时调用的处理函数。通常用于触发 Agent 进行消息处理。
   * @param handler 回调函数，接收聚合后的 PendingInbound 对象
   */
  public setFlushHandler(handler: (pending: PendingInbound) => void) {
    this.onFlush = handler;
  }

  /**
   * **createStream (创建流会话)**
   *
   * 初始化一个新的流式会话状态。
   * @param params.msgid (可选) 企业微信消息 ID，用于后续去重映射
   * @returns 生成的 streamId (Hex 字符串)
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
   * **getStream (获取流状态)**
   *
   * 根据 streamId 获取当前的会话状态。
   * @param streamId 流会话 ID
   */
  getStream(streamId: string): StreamState | undefined {
    return this.streams.get(streamId);
  }

  /**
   * **getStreamByMsgId (通过 msgid 查找流 ID)**
   *
   * 用于消息去重：检查该 msgid 是否已经关联由正在进行或已完成的流会话。
   * @param msgid 企业微信消息 ID
   */
  getStreamByMsgId(msgid: string): string | undefined {
    return this.msgidToStreamId.get(String(msgid));
  }

  setStreamIdForMsgId(msgid: string, streamId: string): void {
    const key = String(msgid).trim();
    const value = String(streamId).trim();
    if (!key || !value) return;
    this.msgidToStreamId.set(key, value);
  }

  /**
   * 将“回执流”(ack stream) 关联到某个“批次流”(batch stream)。
   * 用于：当用户连发多条消息被合并排队时，让后续消息的 stream 最终也能更新为可理解的提示，而不是永久停留在“已合并排队…”。
   */
  addAckStreamForBatch(params: { batchStreamId: string; ackStreamId: string }): void {
    const batchStreamId = params.batchStreamId.trim();
    const ackStreamId = params.ackStreamId.trim();
    if (!batchStreamId || !ackStreamId) return;
    const list = this.batchStreamIdToAckStreamIds.get(batchStreamId) ?? [];
    list.push(ackStreamId);
    this.batchStreamIdToAckStreamIds.set(batchStreamId, list);
  }

  /**
   * 取出并清空某个批次流关联的所有回执流。
   */
  drainAckStreamsForBatch(batchStreamId: string): string[] {
    const key = batchStreamId.trim();
    if (!key) return [];
    const list = this.batchStreamIdToAckStreamIds.get(key) ?? [];
    this.batchStreamIdToAckStreamIds.delete(key);
    return list;
  }

  /**
   * **updateStream (更新流状态)**
   *
   * 原子更新流状态，并自动刷新 updatedAt 时间戳。
   * @param streamId 流会话 ID
   * @param mutator 状态修改函数
   */
  updateStream(streamId: string, mutator: (state: StreamState) => void): void {
    const state = this.streams.get(streamId);
    if (state) {
      mutator(state);
      state.updatedAt = Date.now();
    }
  }

  /**
   * **markStarted (标记流开始)**
   *
   * 标记该流会话已经开始处理（通常在 Agent 启动后调用）。
   */
  markStarted(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.started = true;
    });
  }

  /**
   * **markFinished (标记流结束)**
   *
   * 标记该流会话已完成，不再接收内容更新。
   */
  markFinished(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.finished = true;
    });
  }

  /**
   * **addPendingMessage (添加待处理消息 / 防抖聚合)**
   *
   * 将收到的消息加入待处理队列。如果相同 pendingKey 已存在，则是防抖聚合；否则创建新条目。
   * 会自动设置或重置防抖定时器。
   *
   * @param params 消息参数
   * @returns { streamId, isNew } isNew=true 表示这是新的一组消息，需初始化 ActiveReply
   */
  addPendingMessage(params: {
    conversationKey: string;
    target: WecomWebhookTarget;
    msg: WecomInboundMessage;
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
      // 第一批次（active）
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

    // 合并规则（排队语义）：
    // - 初始批次（batchKey===conversationKey）不接收合并：避免 1/2 都刷出同一份最终答案。
    // - 如果 active 批次是“排队批次”（batchKey!=conversationKey）且还没开始处理（started=false），
    //   则允许把后续消息合并进该 active 批次（典型：1 很快结束，2 变 active 但还没开始跑，3 合并到 2）。
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
          // 注意：不把该 msgid 映射到 active streamId（避免该消息最终也刷出同一份完整答案）
        }
        if (activePending.timeout) clearTimeout(activePending.timeout);
        activePending.timeout = setTimeout(() => {
          this.requestFlush(activeBatchKey);
        }, effectiveDebounceMs);
        return { streamId: activePending.streamId, status: "active_merged" };
      }
    }

    // active 批次已经开始处理；后续消息进入队列批次（queued），并允许在队列批次内做防抖聚合。
    const queuedBatchKey = state.queue[0];
    if (queuedBatchKey) {
      const existingQueued = this.pendingInbounds.get(queuedBatchKey);
      if (existingQueued) {
        existingQueued.contents.push(msgContent);
        if (msg.msgid) {
          existingQueued.msgids.push(msg.msgid);
          // 注意：不把该 msgid 映射到 queued streamId（避免该消息最终也刷出同一份完整答案）
        }
        if (existingQueued.timeout) clearTimeout(existingQueued.timeout);

        existingQueued.timeout = setTimeout(() => {
          this.requestFlush(queuedBatchKey);
        }, effectiveDebounceMs);
        return { streamId: existingQueued.streamId, status: "queued_merged" };
      }
    }

    // 创建新的 queued 批次（会话只保留 1 个“下一批次”，后续消息继续合并到该批次）
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
    if (!pending) return;

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
    if (!pending) return;

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
    if (!batchKey || !conversationKey) return;

    const conv = this.conversationState.get(conversationKey);
    if (!conv) return;
    if (conv.activeBatchKey !== batchKey) return;

    const next = conv.queue.shift();
    if (!next) {
      // 队列为空：会话已空闲。删除状态，避免后续消息被误判为“排队但永远不触发”。
      this.conversationState.delete(conversationKey);
      return;
    }
    conv.activeBatchKey = next;
    this.conversationState.set(conversationKey, conv);

    const pending = this.pendingInbounds.get(next);
    if (!pending) return;
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

    // 清理过期的流会话
    for (const [id, state] of this.streams.entries()) {
      if (state.updatedAt < streamCutoff) {
        this.streams.delete(id);
        if (state.msgid) {
          // 如果 msgid 映射仍指向该 stream，则一并移除
          if (this.msgidToStreamId.get(state.msgid) === id) {
            this.msgidToStreamId.delete(state.msgid);
          }
        }
      }
    }

    // 清理悬空的 msgid 映射 (Double check)
    for (const [msgid, id] of this.msgidToStreamId.entries()) {
      if (!this.streams.has(id)) {
        this.msgidToStreamId.delete(msgid);
      }
    }

    // 清理超时的 Pending 消息 (通常由 timeout 清理，此处作为兜底)
    for (const [key, pending] of this.pendingInbounds.entries()) {
      if (now - pending.createdAt > LIMITS.STREAM_TTL_MS) {
        if (pending.timeout) clearTimeout(pending.timeout);
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
    if (!url) return;
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
class MonitorState {
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
    if (this.pruneInterval) return;
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
export const monitorState = new MonitorState();
