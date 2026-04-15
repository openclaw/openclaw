import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createLog } from "../../logger.js";

export type YuanbaoTraceContext = {
  traceId: string;
  traceparent: string;
  seqId?: string;
  /** 基于入站 seqId 返回自增的 msg_seq */
  nextMsgSeq: () => number | undefined;
};

const traceStorage = new AsyncLocalStorage<YuanbaoTraceContext>();
const EMPTY_TRACE_ID = "0".repeat(32);

function generateHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * 生成随机 trace ID（32 位十六进制字符串）。
 * 当入站消息未携带 trace_id 时用作兜底生成。
 */
export function generateTraceId(): string {
  return generateHex(16);
}

function normalizeTraceIdForTraceparent(traceId: string): string {
  const normalized = traceId
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (normalized.length >= 32) {
    const candidate = normalized.slice(0, 32);
    if (candidate !== EMPTY_TRACE_ID) {
      return candidate;
    }
  }

  const hashed = createHash("sha256").update(traceId.trim()).digest("hex").slice(0, 32);
  if (hashed !== EMPTY_TRACE_ID) {
    return hashed;
  }

  return generateTraceId();
}

function buildTraceparent(traceId: string): string {
  return `00-${normalizeTraceIdForTraceparent(traceId)}-${generateHex(8)}-01`;
}

function normalizeSeqId(seqId?: string | number): string | undefined {
  if (seqId === undefined || seqId === null) {
    return undefined;
  }
  const normalized = String(seqId).trim();
  return normalized || undefined;
}

/**
 * 解析或生成完整的 trace 上下文。
 * 优先使用入站消息携带的 traceId，缺失时随机生成；
 * 同时解析当前消息关联的 seq_id。
 */
export function resolveTraceContext(params: {
  traceId?: string;
  seqId?: string | number;
}): YuanbaoTraceContext {
  const incomingTraceId = params.traceId?.trim();
  const traceId = incomingTraceId || generateTraceId();
  const seqId = normalizeSeqId(params.seqId);

  const baseSeq = seqId ? parseInt(seqId, 10) : NaN;
  let seqCounter = 0;
  const nextMsgSeq = (): number | undefined => {
    if (Number.isNaN(baseSeq)) {
      return undefined;
    }
    seqCounter++;
    return baseSeq + seqCounter;
  };

  const log = createLog("trace");
  log.debug("[msg-trace] resolve context", {
    traceId,
    generated: !incomingTraceId,
    seqId: seqId ?? "(none)",
  });

  return {
    traceId,
    traceparent: buildTraceparent(traceId),
    nextMsgSeq,
    ...(seqId ? { seqId } : {}),
  };
}

/**
 * 获取当前异步上下文中的 trace 上下文（通过 AsyncLocalStorage）。
 */
export function getActiveTraceContext(): YuanbaoTraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * 在指定的 trace 上下文中执行异步回调。
 * 回调内部（及其触发的所有异步操作）可通过 {@link getActiveTraceContext} 获取该上下文，
 * fetch interceptor 也会自动为 LLM 请求注入对应的 X-Traceparent 头。
 */
export function runWithTraceContext<T>(
  traceContext: YuanbaoTraceContext,
  callback: () => Promise<T>,
): Promise<T> {
  return traceStorage.run(traceContext, callback);
}
