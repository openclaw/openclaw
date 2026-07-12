// Performance Monitor types describe in-memory timing traces.

export type PerformanceMonitorConfig = {
  maxRuns: number;
  maxEventsPerRun: number;
};

export type PerformanceEventKind = "hook_handler" | "phase" | "tool" | "llm" | "run" | "harness";

export type PerformanceEvent = {
  kind: PerformanceEventKind;
  at: number;
  durationMs?: number;
  outcome?: string;
  /** Extension/plugin id for hook handlers, tools, or LLM providers. */
  extensionId?: string;
  /** Plugin hook name, e.g. before_tool_call. */
  hookName?: string;
  toolName?: string;
  /** Registered tool/handler name when available. */
  handlerName?: string;
  /** Plugin registration source file basename when available. */
  handlerSource?: string;
  /** Canonical handler reference for grouping. */
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
  phaseName?: string;
  callId?: string;
  toolCallId?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type PerformanceBreakdownEntry = {
  key: string;
  label: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  errorCount?: number;
};

export type RunPerformanceCategoryTotals = {
  phaseMs: number;
  hookHandlerMs: number;
  toolMs: number;
  llmMs: number;
  harnessMs: number;
  measuredMs: number;
  totalDurationMs?: number;
  /** Wall-clock time not covered by measured hook/tool/llm/phase/harness events. */
  unaccountedMs?: number;
};

export type RunPerformanceBreakdown = {
  /** Core pipeline stages from diagnostic.phase.completed. */
  phases: PerformanceBreakdownEntry[];
  /** Per-plugin hook handler timing. */
  hookHandlers: PerformanceBreakdownEntry[];
  /** Tool execution timing grouped by handlerRef. */
  tools: PerformanceBreakdownEntry[];
  /** Model call timing grouped by handlerRef. */
  llmCalls: PerformanceBreakdownEntry[];
  /** Cross-cutting totals grouped by extension and event kind. */
  byExtension: PerformanceBreakdownEntry[];
  categoryTotals: RunPerformanceCategoryTotals;
};

export type RunPerformanceSummary = {
  hookHandlerCount: number;
  totalHookHandlerMs: number;
  phaseCount: number;
  totalPhaseMs: number;
  toolCallCount: number;
  totalToolMs: number;
  llmCallCount: number;
  totalLlmMs: number;
};

export type RunPerformanceTrace = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  startedAt: number;
  updatedAt: number;
  totalDurationMs?: number;
  outcome?: string;
  events: PerformanceEvent[];
  summary: RunPerformanceSummary;
  /** Aggregated per-turn analysis derived from events. */
  breakdown: RunPerformanceBreakdown;
};

export type PerformanceMonitorReport = {
  generatedAt: number;
  runCount: number;
  runs: Array<{
    runId: string;
    sessionKey?: string;
    startedAt: number;
    updatedAt: number;
    totalDurationMs?: number;
    outcome?: string;
    summary: RunPerformanceSummary;
    breakdown: RunPerformanceBreakdown;
  }>;
};
