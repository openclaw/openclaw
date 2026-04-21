/**
 * Middleware: parse or generate trace context from inbound message trace_id / seq_id.
 * Injected into ctx.traceContext for downstream middlewares and transport layer.
 */

import { resolveTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveTrace: MiddlewareDescriptor = {
  name: "resolve-trace",
  handler: async (ctx, next) => {
    // Parse or generate trace context from inbound message
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
