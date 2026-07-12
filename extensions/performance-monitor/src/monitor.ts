// Performance Monitor core stores bounded per-run timing traces.
import { buildRunPerformanceBreakdown } from "./breakdown.js";
import type {
  PerformanceEvent,
  PerformanceEventKind,
  PerformanceMonitorConfig,
  PerformanceMonitorReport,
  RunPerformanceSummary,
  RunPerformanceTrace,
} from "./types.js";

const DEFAULT_CONFIG: PerformanceMonitorConfig = {
  maxRuns: 100,
  maxEventsPerRun: 500,
};

const EMPTY_SUMMARY = (): RunPerformanceSummary => ({
  hookHandlerCount: 0,
  totalHookHandlerMs: 0,
  phaseCount: 0,
  totalPhaseMs: 0,
  toolCallCount: 0,
  totalToolMs: 0,
  llmCallCount: 0,
  totalLlmMs: 0,
});

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function resolveRunId(runId: string | undefined, fallback?: string): string {
  const trimmed = runId?.trim();
  if (trimmed) {
    return trimmed;
  }
  const fallbackTrimmed = fallback?.trim();
  if (fallbackTrimmed) {
    return fallbackTrimmed;
  }
  return "unknown";
}

function bumpSummary(summary: RunPerformanceSummary, event: PerformanceEvent): void {
  const durationMs = event.durationMs ?? 0;
  switch (event.kind) {
    case "hook_handler":
      summary.hookHandlerCount += 1;
      summary.totalHookHandlerMs = roundMs(summary.totalHookHandlerMs + durationMs);
      return;
    case "phase":
      summary.phaseCount += 1;
      summary.totalPhaseMs = roundMs(summary.totalPhaseMs + durationMs);
      return;
    case "tool":
      summary.toolCallCount += 1;
      summary.totalToolMs = roundMs(summary.totalToolMs + durationMs);
      return;
    case "llm":
      summary.llmCallCount += 1;
      summary.totalLlmMs = roundMs(summary.totalLlmMs + durationMs);
      return;
    default:
      return;
  }
}

export function createPerformanceMonitor(
  config: Partial<PerformanceMonitorConfig> = {},
): PerformanceMonitor {
  return new PerformanceMonitor({
    ...DEFAULT_CONFIG,
    ...config,
  });
}

export class PerformanceMonitor {
  readonly #config: PerformanceMonitorConfig;
  readonly #runs = new Map<string, StoredRunTrace>();
  readonly #runOrder: string[] = [];

  constructor(config: PerformanceMonitorConfig) {
    this.#config = config;
  }

  recordEvent(params: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    kind: PerformanceEventKind;
    at?: number;
    durationMs?: number;
    outcome?: string;
    extensionId?: string;
    hookName?: string;
    toolName?: string;
    handlerName?: string;
    handlerSource?: string;
    handlerRef?: string;
    toolSource?: string;
    mcpServerName?: string;
    mcpToolName?: string;
    provider?: string;
    model?: string;
    providerPluginId?: string;
    harnessId?: string;
    api?: string;
    transport?: string;
    traceId?: string;
    spanId?: string;
    phaseName?: string;
    callId?: string;
    toolCallId?: string;
    traceId?: string;
    spanId?: string;
    metadata?: Record<string, string | number | boolean>;
  }): void {
    const runId = resolveRunId(params.runId, params.sessionKey);
    const trace = this.#ensureRun(runId, {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      startedAt: params.at ?? Date.now(),
    });
    if (trace.events.length >= this.#config.maxEventsPerRun) {
      return;
    }

    const event: PerformanceEvent = {
      kind: params.kind,
      at: params.at ?? Date.now(),
      ...(params.durationMs !== undefined ? { durationMs: roundMs(params.durationMs) } : {}),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      ...(params.extensionId ? { extensionId: params.extensionId } : {}),
      ...(params.hookName ? { hookName: params.hookName } : {}),
      ...(params.toolName ? { toolName: params.toolName } : {}),
      ...(params.handlerName ? { handlerName: params.handlerName } : {}),
      ...(params.handlerSource ? { handlerSource: params.handlerSource } : {}),
      ...(params.handlerRef ? { handlerRef: params.handlerRef } : {}),
      ...(params.toolSource ? { toolSource: params.toolSource } : {}),
      ...(params.mcpServerName ? { mcpServerName: params.mcpServerName } : {}),
      ...(params.mcpToolName ? { mcpToolName: params.mcpToolName } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.providerPluginId ? { providerPluginId: params.providerPluginId } : {}),
      ...(params.harnessId ? { harnessId: params.harnessId } : {}),
      ...(params.api ? { api: params.api } : {}),
      ...(params.transport ? { transport: params.transport } : {}),
      ...(params.phaseName ? { phaseName: params.phaseName } : {}),
      ...(params.callId ? { callId: params.callId } : {}),
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      ...(params.traceId ? { traceId: params.traceId } : {}),
      ...(params.spanId ? { spanId: params.spanId } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    trace.events.push(event);
    trace.updatedAt = event.at;
    bumpSummary(trace.summary, event);
  }

  finalizeRun(params: { runId: string; durationMs?: number; outcome?: string; at?: number }): void {
    const trace = this.#runs.get(params.runId);
    if (!trace) {
      return;
    }
    trace.totalDurationMs =
      params.durationMs !== undefined ? roundMs(params.durationMs) : trace.totalDurationMs;
    trace.outcome = params.outcome ?? trace.outcome;
    trace.updatedAt = params.at ?? Date.now();
    this.#trimRuns();
  }

  getRunTrace(runId: string): RunPerformanceTrace | undefined {
    const trace = this.#runs.get(runId);
    return trace ? attachBreakdown(cloneTrace(trace)) : undefined;
  }

  getReport(): PerformanceMonitorReport {
    const runs = [...this.#runOrder]
      .map((runId) => this.#runs.get(runId))
      .filter((trace): trace is StoredRunTrace => trace !== undefined)
      .map((trace) => {
        const withBreakdown = attachBreakdown(cloneTrace(trace));
        return {
          runId: withBreakdown.runId,
          sessionKey: withBreakdown.sessionKey,
          startedAt: withBreakdown.startedAt,
          updatedAt: withBreakdown.updatedAt,
          totalDurationMs: withBreakdown.totalDurationMs,
          outcome: withBreakdown.outcome,
          summary: { ...withBreakdown.summary },
          breakdown: withBreakdown.breakdown,
        };
      });

    return {
      generatedAt: Date.now(),
      runCount: runs.length,
      runs,
    };
  }

  reset(): void {
    this.#runs.clear();
    this.#runOrder.length = 0;
  }

  #ensureRun(
    runId: string,
    seed: { sessionKey?: string; sessionId?: string; startedAt: number },
  ): StoredRunTrace {
    const existing = this.#runs.get(runId);
    if (existing) {
      if (seed.sessionKey && !existing.sessionKey) {
        existing.sessionKey = seed.sessionKey;
      }
      if (seed.sessionId && !existing.sessionId) {
        existing.sessionId = seed.sessionId;
      }
      return existing;
    }

    const trace: StoredRunTrace = {
      runId,
      sessionKey: seed.sessionKey,
      sessionId: seed.sessionId,
      startedAt: seed.startedAt,
      updatedAt: seed.startedAt,
      events: [],
      summary: EMPTY_SUMMARY(),
    };
    this.#runs.set(runId, trace);
    this.#runOrder.push(runId);
    this.#trimRuns();
    return trace;
  }

  #trimRuns(): void {
    while (this.#runOrder.length > this.#config.maxRuns) {
      const runId = this.#runOrder.shift();
      if (!runId) {
        break;
      }
      this.#runs.delete(runId);
    }
  }
}

function cloneTrace(trace: StoredRunTrace): StoredRunTrace {
  return {
    ...trace,
    events: trace.events.map((event) => ({
      ...event,
      ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
    })),
    summary: { ...trace.summary },
  };
}

function attachBreakdown(trace: StoredRunTrace): RunPerformanceTrace {
  return {
    ...trace,
    breakdown: buildRunPerformanceBreakdown(trace),
  };
}

type StoredRunTrace = Omit<RunPerformanceTrace, "breakdown">;

export const testApi = {
  resolveRunId,
  roundMs,
};

export { testApi as __test__ };
