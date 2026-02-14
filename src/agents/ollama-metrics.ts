export interface OllamaPerformanceMetrics {
  totalDurationMs: number;
  loadDurationMs: number;
  promptEvalDurationMs: number;
  evalDurationMs: number;
  promptTokens: number;
  evalTokens: number;
  tokensPerSecond: number;
  promptTokensPerSecond: number;
  timeToFirstToken: number;
}

interface OllamaDoneChunk {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

const NS_TO_MS = 1e-6;

export function extractMetrics(response: OllamaDoneChunk): OllamaPerformanceMetrics | null {
  if (response.eval_count == null && response.eval_duration == null) {
    return null;
  }

  const loadDurationMs = (response.load_duration ?? 0) * NS_TO_MS;
  const promptEvalDurationMs = (response.prompt_eval_duration ?? 0) * NS_TO_MS;
  const evalDurationMs = (response.eval_duration ?? 0) * NS_TO_MS;
  const promptTokens = response.prompt_eval_count ?? 0;
  const evalTokens = response.eval_count ?? 0;

  return {
    totalDurationMs: (response.total_duration ?? 0) * NS_TO_MS,
    loadDurationMs,
    promptEvalDurationMs,
    evalDurationMs,
    promptTokens,
    evalTokens,
    tokensPerSecond: evalDurationMs > 0 ? evalTokens / (evalDurationMs / 1000) : 0,
    promptTokensPerSecond:
      promptEvalDurationMs > 0 ? promptTokens / (promptEvalDurationMs / 1000) : 0,
    timeToFirstToken: loadDurationMs + promptEvalDurationMs,
  };
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function formatMetrics(m: OllamaPerformanceMetrics): string {
  return `${m.tokensPerSecond.toFixed(1)} tok/s • ${fmtMs(m.timeToFirstToken)} to first token • ${m.evalTokens} tokens generated`;
}

export function formatMetricsCompact(m: OllamaPerformanceMetrics): string {
  return `${m.tokensPerSecond.toFixed(1)} t/s • ${fmtMs(m.timeToFirstToken)} TTFT`;
}
