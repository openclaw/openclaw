/**
 * Runtime Behavioral Health Monitor (VIGIL-Inspired)
 *
 * Tracks aggregate tool call patterns during agent execution to detect
 * degradation signals in real-time:
 * - Repeated failures on the same tool (failure streaks)
 * - Execution loops (same tool+params called repeatedly)
 * - Rising error rates within a sliding window
 * - Context budget exhaustion trends
 * - Stalled progress (no successful actions over time)
 *
 * Unlike individual error classifiers, this monitors the overall "health"
 * of an agent session and triggers adaptive interventions before the agent
 * enters a terminal failure state.
 *
 * Inspired by: VIGIL: A Reflective Runtime for Self-Healing Agents
 * https://arxiv.org/abs/2512.07094
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolErrorCategory =
  | "transient"
  | "resource"
  | "semantic"
  | "permanent"
  | "context_limit";

export type HealthStatus = "healthy" | "degraded" | "critical";

export type DegradationSignal =
  | "failure_streak"
  | "execution_loop"
  | "rising_error_rate"
  | "context_exhaustion"
  | "stalled_progress";

export type InterventionAction =
  | "none"
  | "warn"
  | "switch_strategy"
  | "compact_context"
  | "escalate_to_human";

export type HealthEvent = {
  toolName: string;
  toolCallId?: string;
  success: boolean;
  params?: Record<string, unknown>;
  errorCategory?: ToolErrorCategory;
  contextUsagePercent?: number;
  timestamp: number;
};

export type DegradationReport = {
  signal: DegradationSignal;
  severity: number; // 0-1
  detail: string;
  suggestedAction: InterventionAction;
  affectedTools: string[];
};

export type HealthAssessment = {
  status: HealthStatus;
  score: number; // 0-100, higher = healthier
  degradations: DegradationReport[];
  suggestedAction: InterventionAction;
  summary: string;
  assessedAt: number;
};

export type BehavioralHealthConfig = {
  /** Size of the sliding window for event analysis */
  windowSize?: number;
  /** Number of consecutive failures to trigger failure_streak */
  failureStreakThreshold?: number;
  /** Number of identical calls to trigger execution_loop */
  loopDetectionThreshold?: number;
  /** Error rate (0-1) within window to trigger rising_error_rate */
  errorRateThreshold?: number;
  /** Context usage percent (0-100) to trigger context_exhaustion warning */
  contextWarningThreshold?: number;
  /** Context usage percent (0-100) to trigger critical context_exhaustion */
  contextCriticalThreshold?: number;
  /** Number of events without success to trigger stalled_progress */
  stalledProgressThreshold?: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<BehavioralHealthConfig> = {
  windowSize: 20,
  failureStreakThreshold: 3,
  loopDetectionThreshold: 3,
  errorRateThreshold: 0.6,
  contextWarningThreshold: 70,
  contextCriticalThreshold: 90,
  stalledProgressThreshold: 8,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type BehavioralHealthMonitor = {
  /** Record a tool execution event */
  recordEvent(event: HealthEvent): void;

  /** Get the current health assessment */
  assess(): HealthAssessment;

  /** Get the current health status (quick check, no full report) */
  getStatus(): HealthStatus;

  /** Get the event count in the current window */
  getEventCount(): number;

  /** Reset the monitor (e.g., after a strategy switch) */
  reset(): void;
};

/**
 * Create a behavioral health monitor for an agent session.
 */
export function createBehavioralHealthMonitor(
  userConfig?: BehavioralHealthConfig,
): BehavioralHealthMonitor {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const events: HealthEvent[] = [];

  function getWindow(): HealthEvent[] {
    return events.slice(-config.windowSize);
  }

  /**
   * Detect consecutive failures on any tool.
   */
  function detectFailureStreak(): DegradationReport | undefined {
    const window = getWindow();
    if (window.length < config.failureStreakThreshold) {
      return undefined;
    }

    // Check from the end of the window for consecutive failures
    let streak = 0;
    const failedTools = new Set<string>();
    for (let i = window.length - 1; i >= 0; i--) {
      const event = window[i];
      if (!event.success) {
        streak++;
        failedTools.add(event.toolName);
      } else {
        break;
      }
    }

    if (streak >= config.failureStreakThreshold) {
      const severity = Math.min(streak / (config.failureStreakThreshold * 2), 1);
      return {
        signal: "failure_streak",
        severity,
        detail: `${streak} consecutive failures detected across tools: ${[...failedTools].join(", ")}`,
        suggestedAction: severity > 0.7 ? "switch_strategy" : "warn",
        affectedTools: [...failedTools],
      };
    }

    return undefined;
  }

  /**
   * Detect repeated identical tool calls (same tool + similar params).
   */
  function detectExecutionLoop(): DegradationReport | undefined {
    const window = getWindow();
    if (window.length < config.loopDetectionThreshold) {
      return undefined;
    }

    // Build a fingerprint for each event
    const fingerprints: string[] = window.map(
      (e) => `${e.toolName}:${e.params ? stableStringify(e.params) : ""}`,
    );

    // Check for repeated consecutive fingerprints
    let maxRepeat = 1;
    let currentRepeat = 1;
    let repeatedFingerprint = "";

    for (let i = 1; i < fingerprints.length; i++) {
      if (fingerprints[i] === fingerprints[i - 1]) {
        currentRepeat++;
        if (currentRepeat > maxRepeat) {
          maxRepeat = currentRepeat;
          repeatedFingerprint = fingerprints[i]!;
        }
      } else {
        currentRepeat = 1;
      }
    }

    if (maxRepeat >= config.loopDetectionThreshold) {
      const toolName = repeatedFingerprint.split(":")[0] ?? "unknown";
      const severity = Math.min(maxRepeat / (config.loopDetectionThreshold * 2), 1);
      return {
        signal: "execution_loop",
        severity,
        detail: `Tool "${toolName}" called ${maxRepeat} times with identical parameters — possible infinite loop`,
        suggestedAction: severity > 0.7 ? "escalate_to_human" : "switch_strategy",
        affectedTools: [toolName],
      };
    }

    return undefined;
  }

  /**
   * Detect rising error rates within the sliding window.
   */
  function detectRisingErrorRate(): DegradationReport | undefined {
    const window = getWindow();
    // Need minimum events for meaningful rate
    if (window.length < 5) {
      return undefined;
    }

    const failures = window.filter((e) => !e.success).length;
    const errorRate = failures / window.length;

    if (errorRate >= config.errorRateThreshold) {
      // Identify which tools are failing
      const toolFailures = new Map<string, number>();
      for (const event of window) {
        if (!event.success) {
          toolFailures.set(event.toolName, (toolFailures.get(event.toolName) ?? 0) + 1);
        }
      }

      const affectedTools = [...toolFailures.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .map(([name]) => name);

      const severity = Math.min(errorRate / 1, 1); // Cap at 1
      return {
        signal: "rising_error_rate",
        severity,
        detail: `Error rate at ${(errorRate * 100).toFixed(0)}% (${failures}/${window.length}) — degraded performance`,
        suggestedAction: severity > 0.8 ? "switch_strategy" : "warn",
        affectedTools,
      };
    }

    return undefined;
  }

  /**
   * Detect context budget exhaustion based on reported context usage.
   */
  function detectContextExhaustion(): DegradationReport | undefined {
    // Find the most recent event with context usage data
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.contextUsagePercent != null) {
        if (event.contextUsagePercent >= config.contextCriticalThreshold) {
          return {
            signal: "context_exhaustion",
            severity: 1,
            detail: `Context usage at ${event.contextUsagePercent.toFixed(0)}% — critical, compaction needed immediately`,
            suggestedAction: "compact_context",
            affectedTools: [],
          };
        }
        if (event.contextUsagePercent >= config.contextWarningThreshold) {
          const severity =
            (event.contextUsagePercent - config.contextWarningThreshold) /
            (config.contextCriticalThreshold - config.contextWarningThreshold);
          return {
            signal: "context_exhaustion",
            severity: Math.min(severity, 0.9),
            detail: `Context usage at ${event.contextUsagePercent.toFixed(0)}% — approaching limit`,
            suggestedAction: "warn",
            affectedTools: [],
          };
        }
        break; // Only check the most recent context usage report
      }
    }

    return undefined;
  }

  /**
   * Detect stalled progress (too many events without a success).
   */
  function detectStalledProgress(): DegradationReport | undefined {
    if (events.length < config.stalledProgressThreshold) {
      return undefined;
    }

    // Count consecutive non-success events from the end
    let stalledCount = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (!events[i].success) {
        stalledCount++;
      } else {
        break;
      }
    }

    if (stalledCount >= config.stalledProgressThreshold) {
      const affectedTools = new Set<string>();
      for (let i = events.length - stalledCount; i < events.length; i++) {
        affectedTools.add(events[i].toolName);
      }

      const severity = Math.min(stalledCount / (config.stalledProgressThreshold * 2), 1);
      return {
        signal: "stalled_progress",
        severity,
        detail: `No successful tool calls in last ${stalledCount} attempts — agent may be stuck`,
        suggestedAction: severity > 0.7 ? "escalate_to_human" : "switch_strategy",
        affectedTools: [...affectedTools],
      };
    }

    return undefined;
  }

  /**
   * Compute an overall health score from degradation reports.
   */
  function computeHealthScore(degradations: DegradationReport[]): number {
    if (degradations.length === 0) {
      return 100;
    }

    // Each degradation reduces the score proportional to its severity
    let score = 100;
    for (const d of degradations) {
      // Weight different signals differently
      const weight = SIGNAL_WEIGHTS[d.signal] ?? 1;
      score -= d.severity * weight * 20;
    }

    return Math.max(0, Math.min(100, score));
  }

  function deriveStatus(score: number): HealthStatus {
    if (score >= 70) {
      return "healthy";
    }
    if (score >= 40) {
      return "degraded";
    }
    return "critical";
  }

  function deriveAction(degradations: DegradationReport[]): InterventionAction {
    if (degradations.length === 0) {
      return "none";
    }

    // Use the most severe action from all degradations
    const actionPriority: InterventionAction[] = [
      "none",
      "warn",
      "switch_strategy",
      "compact_context",
      "escalate_to_human",
    ];

    let maxPriority = 0;
    for (const d of degradations) {
      const priority = actionPriority.indexOf(d.suggestedAction);
      if (priority > maxPriority) {
        maxPriority = priority;
      }
    }

    return actionPriority[maxPriority] ?? "none";
  }

  function buildSummary(status: HealthStatus, degradations: DegradationReport[]): string {
    if (status === "healthy") {
      return "Agent is operating normally.";
    }

    const signals = degradations.map((d) => d.detail).join("; ");
    if (status === "critical") {
      return `CRITICAL: ${signals}`;
    }
    return `Degraded: ${signals}`;
  }

  return {
    recordEvent(event: HealthEvent): void {
      events.push(event);

      // Keep events bounded to 2x window size for efficiency
      const maxEvents = config.windowSize * 2;
      if (events.length > maxEvents) {
        events.splice(0, events.length - maxEvents);
      }
    },

    assess(): HealthAssessment {
      const degradations: DegradationReport[] = [];

      const failureStreak = detectFailureStreak();
      if (failureStreak) {
        degradations.push(failureStreak);
      }

      const executionLoop = detectExecutionLoop();
      if (executionLoop) {
        degradations.push(executionLoop);
      }

      const risingErrorRate = detectRisingErrorRate();
      if (risingErrorRate) {
        degradations.push(risingErrorRate);
      }

      const contextExhaustion = detectContextExhaustion();
      if (contextExhaustion) {
        degradations.push(contextExhaustion);
      }

      const stalledProgress = detectStalledProgress();
      if (stalledProgress) {
        degradations.push(stalledProgress);
      }

      const score = computeHealthScore(degradations);
      const status = deriveStatus(score);
      const suggestedAction = deriveAction(degradations);
      const summary = buildSummary(status, degradations);

      return {
        status,
        score,
        degradations,
        suggestedAction,
        summary,
        assessedAt: Date.now(),
      };
    },

    getStatus(): HealthStatus {
      // Quick assessment without full report
      const assessment = this.assess();
      return assessment.status;
    },

    getEventCount(): number {
      return events.length;
    },

    reset(): void {
      events.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Weights for each degradation signal type (higher = more impactful) */
const SIGNAL_WEIGHTS: Record<DegradationSignal, number> = {
  failure_streak: 1.0,
  execution_loop: 1.5, // Loops are particularly wasteful
  rising_error_rate: 1.0,
  context_exhaustion: 1.2, // Context is a precious resource
  stalled_progress: 1.3, // Stalled = nothing useful happening
};

/**
 * Produce a stable JSON string for parameter comparison.
 * Keys are sorted so that { a: 1, b: 2 } === { b: 2, a: 1 }.
 */
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).toSorted();
  const parts: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val !== undefined) {
      parts.push(
        `${key}:${typeof val === "object" && val !== null ? JSON.stringify(val) : JSON.stringify(val)}`,
      );
    }
  }
  return parts.join("|");
}
