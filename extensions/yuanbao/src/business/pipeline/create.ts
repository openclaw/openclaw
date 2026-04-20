/**
 * Default message processing pipeline factory.
 *
 * Register middleware by stage, building the complete message processing pipeline.
 */

import { MessagePipeline } from "./engine.js";
import {
  extractContent,
  skipSelf,
  skipPlaceholder,
  resolveQuote,
  guardCommand,
  resolveMention,
  rewriteBody,
  downloadMedia,
  resolveRoute,
  resolveTrace,
  buildContext,
  prepareSender,
  dispatchReply,
} from "./middlewares/index.js";

export function createPipeline(): MessagePipeline {
  return (
    new MessagePipeline()
      // Phase 1: Message parsing
      .use(extractContent) // Extract text/media/@info
      .use(skipSelf) // Skip bot's own messages
      .use(skipPlaceholder) // Skip placeholder/empty messages
      .use(resolveQuote) // Parse quoted messages
      // Phase 2: Guards
      .use(guardCommand) // SDK resolveControlCommandGate
      .use(resolveMention) // SDK resolveMentionGatingWithBypass (group chat)
      // Phase 3: Message preprocessing
      .use(rewriteBody) // Command rewrite + quote concat + mentions concat
      .use(downloadMedia) // Media download
      // Phase 4: Routing & context building
      .use(resolveRoute) // SDK resolveAgentRoute + resolveInboundSessionEnvelopeContext
      .use(resolveTrace) // Parse trace context (trace_id / seq_id -> ctx.traceContext)
      .use(buildContext) // SDK finalizeInboundContext + group history context
      // Phase 5: Sender preparation & AI dispatch
      .use(prepareSender) // Create MessageSender + QueueSession
      .use(dispatchReply)
  ); // ⭐ SDK dispatchInboundReplyWithBase
}
