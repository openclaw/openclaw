/**
 * Trace Standard
 *
 * Standardized tracing for all agent flows.
 * Links: request → routing → execution → outcome
 * Provides observability and feedback loop for improvements.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const TRACE_DIR = path.join(process.cwd(), "memory", "traces");

// Ensure directory exists
if (!fs.existsSync(TRACE_DIR)) {
  fs.mkdirSync(TRACE_DIR, { recursive: true });
}

export interface TraceStep {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  latency: number;
  tokens?: number;
  timestamp: string;
  success: boolean;
}

export interface TraceRouting {
  level: string;
  justification: string;
  confidence: number;
  timestamp: string;
}

export interface TraceOutcome {
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: string;
}

export interface TraceFeedback {
  rating: number | string;
  comment?: string;
  timestamp: string;
}

export interface TraceData {
  id: string;
  startedAt: string;
  completedAt?: string;
  request: {
    text: string;
    timestamp: string;
  };
  routing: TraceRouting | null;
  steps: TraceStep[];
  outcome: TraceOutcome | null;
  feedback: TraceFeedback | null;
  metrics: {
    totalTokens: number;
    totalLatency: number;
    toolCalls: number;
  };
  duration?: number;
}

export interface TraceInstance {
  id: string;
  data: TraceData;
  logRouting: (routing: Omit<TraceRouting, "timestamp">) => TraceInstance;
  logStep: (step: Omit<TraceStep, "id" | "timestamp">) => TraceInstance;
  logOutcome: (outcome: Omit<TraceOutcome, "timestamp">) => TraceInstance;
  logFeedback: (feedback: Omit<TraceFeedback, "timestamp">) => TraceInstance;
  save: () => TraceInstance;
}

/**
 * Create a new trace
 */
export function createTrace(request: string): TraceInstance {
  const traceId = `trace-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const trace: TraceData = {
    id: traceId,
    startedAt: new Date().toISOString(),
    request: {
      text: request,
      timestamp: new Date().toISOString(),
    },
    routing: null,
    steps: [],
    outcome: null,
    feedback: null,
    metrics: {
      totalTokens: 0,
      totalLatency: 0,
      toolCalls: 0,
    },
  };

  return {
    id: traceId,
    data: trace,

    logRouting(routing) {
      trace.routing = {
        ...routing,
        timestamp: new Date().toISOString(),
      };
      return this;
    },

    logStep(step) {
      trace.steps.push({
        id: `step-${trace.steps.length}`,
        ...step,
        timestamp: new Date().toISOString(),
      });

      // Update metrics
      trace.metrics.totalTokens += step.tokens || 0;
      trace.metrics.totalLatency += step.latency || 0;
      trace.metrics.toolCalls++;

      return this;
    },

    logOutcome(outcome) {
      trace.outcome = {
        ...outcome,
        timestamp: new Date().toISOString(),
      };
      trace.completedAt = new Date().toISOString();

      // Calculate duration
      const start = new Date(trace.startedAt).getTime();
      const end = new Date(trace.completedAt).getTime();
      trace.duration = end - start;

      this.save();
      return this;
    },

    logFeedback(feedback) {
      trace.feedback = {
        ...feedback,
        timestamp: new Date().toISOString(),
      };
      this.save();
      return this;
    },

    save() {
      const filePath = path.join(TRACE_DIR, `${trace.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(trace, null, 2));
      return this;
    },
  };
}

export interface TraceFilters {
  level?: string;
  success?: boolean;
  since?: string;
}

/**
 * Load traces for analysis
 */
export function loadTraces(filters: TraceFilters = {}): TraceData[] {
  const files = fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith(".json"));
  const traces: TraceData[] = [];

  for (const file of files) {
    try {
      const trace = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, file), "utf8")) as TraceData;

      // Apply filters
      if (filters.level && trace.routing?.level !== filters.level) {
        continue;
      }
      if (filters.success !== undefined && trace.outcome?.success !== filters.success) {
        continue;
      }
      if (filters.since && new Date(trace.startedAt) < new Date(filters.since)) {
        continue;
      }

      traces.push(trace);
    } catch {
      // Skip corrupted traces
    }
  }

  return traces.toSorted(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

export interface TraceAnalysis {
  total: number;
  byLevel: Record<string, number>;
  byOutcome: { success: number; failure: number };
  avgDuration: number;
  avgTokens: number;
  commonFailures: Array<{ error: string; count: number }>;
  feedback: { positive: number; negative: number };
}

/**
 * Analyze traces for improvement opportunities
 */
export function analyzeTraces(): TraceAnalysis {
  const traces = loadTraces();

  const analysis: TraceAnalysis = {
    total: traces.length,
    byLevel: {},
    byOutcome: { success: 0, failure: 0 },
    avgDuration: 0,
    avgTokens: 0,
    commonFailures: [],
    feedback: { positive: 0, negative: 0 },
  };

  let totalDuration = 0;
  let totalTokens = 0;
  const failurePatterns: Record<string, number> = {};

  for (const trace of traces) {
    // By level
    const level = trace.routing?.level || "unknown";
    analysis.byLevel[level] = (analysis.byLevel[level] || 0) + 1;

    // By outcome
    if (trace.outcome?.success) {
      analysis.byOutcome.success++;
    } else {
      analysis.byOutcome.failure++;

      // Track failure patterns
      const error = trace.outcome?.error || "unknown";
      failurePatterns[error] = (failurePatterns[error] || 0) + 1;
    }

    // Metrics
    totalDuration += trace.duration || 0;
    totalTokens += trace.metrics?.totalTokens || 0;

    // Feedback
    if (trace.feedback) {
      if (
        trace.feedback.rating === "👍" ||
        (typeof trace.feedback.rating === "number" && trace.feedback.rating >= 4)
      ) {
        analysis.feedback.positive++;
      } else {
        analysis.feedback.negative++;
      }
    }
  }

  // Guard against division by zero
  analysis.avgDuration = traces.length > 0 ? totalDuration / traces.length : 0;
  analysis.avgTokens = traces.length > 0 ? totalTokens / traces.length : 0;

  // Top failure patterns
  analysis.commonFailures = Object.entries(failurePatterns)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([error, count]) => ({ error, count }));

  return analysis;
}

export interface Recommendation {
  type: string;
  issue: string;
  detail: string;
  action: string;
}

/**
 * Generate improvement recommendations based on traces
 */
export function generateRecommendations(): Recommendation[] {
  const analysis = analyzeTraces();
  const recommendations: Recommendation[] = [];

  // Check for routing inefficiencies
  const agentCount = analysis.byLevel.agent || 0;
  const total = analysis.total;
  const agentRatio = total > 0 ? agentCount / total : 0;

  if (agentRatio > 0.7) {
    recommendations.push({
      type: "routing",
      issue: "High agent usage",
      detail: `${Math.round(agentRatio * 100)}% of requests use full agent mode`,
      action: "Review RAG and Workflow patterns to catch more requests at lower levels",
    });
  }

  // Check for common failures
  for (const failure of analysis.commonFailures) {
    recommendations.push({
      type: "failure",
      issue: failure.error,
      detail: `Occurred ${failure.count} times`,
      action: "Add error handling or retry logic for this failure mode",
    });
  }

  // Check for negative feedback patterns
  if (analysis.feedback.negative > analysis.feedback.positive) {
    recommendations.push({
      type: "quality",
      issue: "Negative feedback trend",
      detail: `${analysis.feedback.negative} negative vs ${analysis.feedback.positive} positive`,
      action: "Review recent failures and adjust prompts or routing",
    });
  }

  return recommendations;
}
