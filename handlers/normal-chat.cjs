// Normal Chat Handler — DecisionEngine routing (Ollama/Claude)
// Priority 4 (lowest — fallback after all specific handlers)
// Uses DecisionEngine to select executor, quality gates, streaming metrics

module.exports = {
  name: "normal-chat",
  priority: 4,

  /**
   * @param {Object} deps - {
   *   decisionEngine, ollamaRouter, prepareOllamaMessages,
   *   trackTokenUsage, handleWithSkillTools, intentPromise, intentAbort
   * }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    // Always matches as fallback (when no skillContext)
    return !ctx.skillContext;
  },

  async execute(ctx) {
    const { decisionEngine, ollamaRouter, prepareOllamaMessages, trackTokenUsage } = this._deps;

    const { userText, forceModel, messages, memoryContext, trace, reqId, wantsStream } = ctx;

    const isForceOllama = forceModel === "ollama" || forceModel === "glm";
    const isForceClaude = forceModel === "claude" || forceModel === "opus";

    // Await intent if pending
    if (ctx.intentPromise && !ctx.intentHint) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1200));
      await Promise.race([ctx.intentPromise, timeout]);
      if (ctx.req?.intent_hint?.source === "signal" && ctx.intentAbort) {
        ctx.intentAbort();
      }
    }

    const decision = decisionEngine.decide(
      { userText, intentHint: ctx.intentHint || ctx.req?.intent_hint, forceModel },
      trace,
    );
    const useOllama = isForceOllama || (!isForceClaude && decision.executor === "ollama");

    if (useOllama) {
      const ollamaModelName = forceModel === "glm" ? "glm-4.7-flash" : "qwen2.5-coder:7b";
      const ollamaMessages = prepareOllamaMessages(messages, memoryContext);
      const ollamaOpts = forceModel === "glm" ? ollamaRouter.getModelForForce("glm") : {};

      const ollamaResult = await new Promise((resolve) => {
        ollamaRouter.tryOllamaChatStream(
          ollamaMessages,
          ollamaOpts,
          () => {},
          (result) => resolve({ success: true, ...result }),
          (err) => resolve({ success: false, reason: err.message }),
        );
      });

      if (ollamaResult.success) {
        const quality = ollamaRouter.assessQuality(ollamaResult.content, userText);
        const qualityThreshold =
          decision.intent.complexity > 0.6 ? 0.8 : decision.intent.complexity > 0.3 ? 0.6 : 0.4;
        const qualityOk = quality >= qualityThreshold || isForceOllama;

        if (qualityOk) {
          const latencySec = (ollamaResult.latency / 1000).toFixed(1);
          const modelName = ollamaResult.model || ollamaModelName;
          const footer = `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nOllama ${modelName} (${latencySec}s)`;

          trackTokenUsage(
            modelName,
            "ollama",
            {
              input_tokens: ollamaResult.promptTokens || 0,
              output_tokens: ollamaResult.evalTokens || 0,
            },
            ollamaResult.latency,
          );

          const streamMetrics = ollamaResult.metrics || {};
          return {
            status: "handled",
            body: ollamaResult.content + footer,
            executor: "ollama",
            tracePatch: {
              route_path: "ollama_direct",
              executor_ms: ollamaResult.latency,
              ollama_quality_score: quality,
              spans: [
                {
                  stage: "ollama_exec",
                  model: modelName,
                  quality,
                  latency: ollamaResult.latency,
                  success: true,
                },
                {
                  stage: "stream",
                  ttft_ms: streamMetrics.ttft_ms || 0,
                  tps: streamMetrics.tps || 0,
                  total_stream_ms: streamMetrics.total_stream_ms || 0,
                  token_count: streamMetrics.token_count || 0,
                },
              ],
            },
          };
        }

        // Quality reject → fallback to Claude
        return { status: "pass", fallback: true };
      }

      // Ollama error → fallback to Claude
      return { status: "pass", fallback: true };
    }

    // Claude path — return pass to let orchestrator handle passthrough
    return { status: "pass", useClaude: true };
  },
};
