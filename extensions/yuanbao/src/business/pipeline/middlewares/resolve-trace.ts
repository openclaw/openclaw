/**
 * Middleware: parse trace context
 *
 * 从入站消息的 trace_id / seq_id 中解析或生成完整的 trace 上下文，
 * 注入到 ctx.traceContext，供后续中间件（build-context / dispatch-reply）
 * 和 transport 层统一使用。
 */

import { resolveTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveTrace: MiddlewareDescriptor = {
  name: "resolve-trace",
  handler: async (ctx, next) => {
    // 从入站消息中解析或生成 trace 上下文
    ctx.traceContext = resolveTraceContext({
      traceId: ctx.raw.trace_id,
      seqId: ctx.raw.seq_id ?? ctx.raw.msg_seq,
    });

    ctx.log.debug("[resolve-trace] trace context resolved", {
      traceId: ctx.traceContext.traceId,
      seqId: ctx.traceContext.seqId ?? "(none)",
    });

    await next();
  },
};
