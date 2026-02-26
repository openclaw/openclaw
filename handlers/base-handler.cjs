// Handler Execution Contract — Phase 5.1
// Handlers don't write response directly; they return structured results.
// The orchestrator commits the response, records cost, and merges trace.
//
// Handler interface:
//   name: string
//   priority: number (lower = higher priority)
//   match(ctx): boolean | { matched: true, ...extra }
//   execute(ctx): Promise<HandlerResult>
//
// HandlerResult:
//   status: "handled" | "pass" | "error"
//   body: string (response content)
//   executor: string (for cost tracking: "ollama" | "claude" | "local" | ...)
//   streaming: boolean (whether to stream the response)
//   tracePatch: object (spans/metadata to merge into trace)

/**
 * @typedef {Object} HandlerContext
 * @property {string} reqId
 * @property {string} userText
 * @property {Array} messages - Full message array
 * @property {Object} trace
 * @property {Object} req - HTTP request
 * @property {boolean} wantsStream
 * @property {string|null} forceModel
 * @property {Object|null} intentHint
 * @property {string|null} memoryContext
 * @property {Object} metrics - Shared metrics counter
 * @property {Object} decisionEngine
 */

/**
 * @typedef {Object} HandlerResult
 * @property {"handled"|"pass"|"error"} status
 * @property {string} [body]
 * @property {string} [executor]
 * @property {Object} [tracePatch]
 */

class HandlerOrchestrator {
  constructor(handlers, options = {}) {
    // Sort by priority (lower number = higher priority)
    this.handlers = [...handlers].toSorted((a, b) => a.priority - b.priority);
    this.decisionEngine = options.decisionEngine;
    this.sendDirectResponse = options.sendDirectResponse;
    this.streamPassthrough = options.streamPassthrough;
    this.forwardNonStreaming = options.forwardNonStreaming;
  }

  /**
   * Run handlers in priority order.
   * First handler that matches and returns "handled" wins.
   */
  async run(ctx) {
    for (const handler of this.handlers) {
      const matchResult = handler.match(ctx);
      if (!matchResult) {
        continue;
      }

      const extra = typeof matchResult === "object" ? matchResult : {};
      const startMs = Date.now();

      try {
        const result = await handler.execute({ ...ctx, ...extra });

        if (result.status === "handled") {
          // Merge trace
          if (result.tracePatch) {
            if (result.tracePatch.spans) {
              ctx.trace.spans.push(...result.tracePatch.spans);
            }
            if (result.tracePatch.route_path) {
              ctx.trace.route_path = result.tracePatch.route_path;
            }
          }

          // Record cost
          const latencyMs = Date.now() - startMs;
          if (result.executor && this.decisionEngine) {
            this.decisionEngine.recordSuccess(result.executor, latencyMs);
          }

          return result;
        }

        if (result.status === "error") {
          // Record failure
          if (result.executor && this.decisionEngine) {
            this.decisionEngine.recordFailure(result.executor);
          }
          // Fall through to next handler unless error has a body to return
          if (result.body) {
            return result;
          }
          continue;
        }

        // status === "pass" → try next handler
        continue;
      } catch (e) {
        console.error(`[orchestrator] handler ${handler.name} error:`, e.message);
        continue;
      }
    }

    // No handler matched → return pass
    return { status: "pass" };
  }
}

module.exports = { HandlerOrchestrator };
