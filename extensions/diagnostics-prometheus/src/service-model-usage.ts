import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];

export function recordModelUsage(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
) {
  const labels = {
    agent: normalizeDiagnosticValue(evt.agentId),
    channel: normalizeDiagnosticValue(evt.channel),
    model: normalizeDiagnosticValue(evt.model),
    provider: normalizeDiagnosticValue(evt.provider),
  };
  const usage = evt.usage;
  const recordTokens = (tokenType: string, value: number | undefined) => {
    const amount = numericValue(value);
    if (amount === undefined || amount === 0) {
      return;
    }
    store.counter(
      "openclaw_model_tokens_total",
      "Model tokens reported by diagnostic usage events.",
      {
        ...labels,
        token_type: tokenType,
      },
      amount,
    );
    if (tokenType === "input" || tokenType === "output") {
      store.histogram(
        "openclaw_gen_ai_client_token_usage",
        "GenAI token usage distribution for input and output tokens.",
        {
          model: labels.model,
          provider: labels.provider,
          token_type: tokenType,
        },
        amount,
        TOKEN_BUCKETS,
      );
    }
  };

  recordTokens("input", usage.input);
  recordTokens("output", usage.output);
  recordTokens("cache_read", usage.cacheRead);
  recordTokens("cache_write", usage.cacheWrite);
  recordTokens("prompt", usage.promptTokens);
  recordTokens("total", usage.total);

  store.counter(
    "openclaw_model_cost_usd_total",
    "Estimated model cost in USD reported by diagnostic usage events.",
    labels,
    numericValue(evt.costUsd) ?? 0,
  );
  store.histogram(
    "openclaw_model_usage_duration_seconds",
    "Model usage event duration in seconds.",
    labels,
    seconds(evt.durationMs),
  );
}
