import type { McpRuntimeGuardrailsConfig, McpToolAnnotationConfig } from "../config/types.mcp.js";
import { logWarn } from "../logger.js";

// ---- Snapshot types (exported for tests and status surfaces) ----

export type McpToolCircuitState = {
  key: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  nextProbeAt?: number;
};

export type McpCircuitBreakerSnapshot = {
  enabled: boolean;
  observeOnly: boolean;
  states: McpToolCircuitState[];
  wouldBlockCount: number;
};

export type McpBudgetLedgerSnapshot = {
  enabled: boolean;
  observeOnly: boolean;
  totalCalls: number;
  totalWeightedCost: number;
  irreversibleCalls: number;
  callsByKey: Record<string, number>;
  warningsEmitted: string[];
};

export type McpRuntimeGuardrailSnapshot = {
  circuitBreaker: McpCircuitBreakerSnapshot;
  budget: McpBudgetLedgerSnapshot;
};

// ---- Option types ----

export type McpToolCircuitBreakerOptions = {
  enabled?: boolean;
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
};

export type ToolRuntimeBudgetOptions = {
  enabled?: boolean;
  warnAfterCallsPerSession?: number;
  warnAfterWeightedCostPerSession?: number;
  warnAfterIrreversibleCallsPerSession?: number;
  burstWindowMs?: number;
  warnAfterCallsPerBurstWindow?: number;
};

export type ToolRuntimeAnnotation = Required<McpToolAnnotationConfig>;

// ---- Annotation resolution ----

const DEFAULT_ANNOTATION: ToolRuntimeAnnotation = { costWeight: 1, irreversible: false };

export function resolveToolAnnotation(
  serverName: string,
  toolName: string,
  tools?: Record<string, McpToolAnnotationConfig>,
  invalidAnnotationWarnedKeys?: Set<string>,
): ToolRuntimeAnnotation {
  if (!tools) {
    return DEFAULT_ANNOTATION;
  }

  const exactKey = `${serverName}::${toolName}`;
  const wildcardKey = `${serverName}::*`;
  const matchKey = exactKey in tools ? exactKey : wildcardKey in tools ? wildcardKey : undefined;

  if (!matchKey) {
    return DEFAULT_ANNOTATION;
  }

  const raw = tools[matchKey];
  let costWeight = raw.costWeight ?? 1;

  if (!Number.isFinite(costWeight) || costWeight <= 0) {
    const warnKey = `invalid_cost_weight:${matchKey}`;
    if (!invalidAnnotationWarnedKeys?.has(warnKey)) {
      invalidAnnotationWarnedKeys?.add(warnKey);
      logWarn(`bundle-mcp: invalid costWeight for annotation "${matchKey}"; using default 1`);
    }
    costWeight = 1;
  }

  return { costWeight, irreversible: raw.irreversible ?? false };
}

// ---- Circuit breaker ----

type CircuitBreakerResolvedOptions = {
  enabled: boolean;
  observeOnly: boolean;
  failureThreshold: number;
  recoveryTimeoutMs: number;
};

function resolveCircuitBreakerOptions(
  cfg?: McpRuntimeGuardrailsConfig,
  enforceForTesting?: boolean,
): CircuitBreakerResolvedOptions {
  const cb = cfg?.circuitBreaker;
  return {
    enabled: cb?.enabled !== false,
    observeOnly: enforceForTesting !== true,
    failureThreshold: cb?.failureThreshold ?? 3,
    recoveryTimeoutMs: cb?.recoveryTimeoutMs ?? 60_000,
  };
}

export type McpToolCircuitBreaker = {
  run<T>(tool: { serverName: string; toolName: string }, fn: () => Promise<T>): Promise<T>;
  getSnapshot(): McpCircuitBreakerSnapshot;
};

export function createMcpToolCircuitBreaker(opts: {
  cfg?: McpRuntimeGuardrailsConfig;
  now?: () => number;
  enforceForTesting?: boolean;
}): McpToolCircuitBreaker {
  const options = resolveCircuitBreakerOptions(opts.cfg, opts.enforceForTesting);
  const { enabled, observeOnly, failureThreshold, recoveryTimeoutMs } = options;
  const now = opts.now ?? Date.now;
  const states = new Map<string, McpToolCircuitState>();
  let wouldBlockCount = 0;
  const lastWouldBlockWarnAt = new Map<string, number>();

  function getOrInitState(key: string): McpToolCircuitState {
    let state = states.get(key);
    if (!state) {
      state = { key, state: "closed", consecutiveFailures: 0 };
      states.set(key, state);
    }
    return state;
  }

  return {
    async run({ serverName, toolName }, fn) {
      const key = `${serverName}::${toolName}`;

      if (!enabled) {
        return fn();
      }

      const state = getOrInitState(key);
      const nowMs = now();

      if (state.state === "open") {
        if (nowMs >= (state.nextProbeAt ?? 0)) {
          // Cooldown elapsed — move to half-open for a probe
          state.state = "half_open";
        } else {
          // Still in cooldown
          wouldBlockCount += 1;
          const lastWarn = lastWouldBlockWarnAt.get(key) ?? 0;
          if (lastWarn === 0 || nowMs - lastWarn > recoveryTimeoutMs) {
            logWarn(
              `bundle-mcp: circuit open for "${key}" (would_block, observe_only=${String(observeOnly)})`,
            );
            lastWouldBlockWarnAt.set(key, nowMs);
          }
          if (!observeOnly) {
            const retryAfterMs = Math.max(0, (state.nextProbeAt ?? 0) - nowMs);
            throw new Error(
              `bundle-mcp: tool "${key}" circuit open; retry after ${retryAfterMs}ms`,
            );
          }
          // observe-only: fall through and make the call anyway
        }
      }

      const wasHalfOpen = state.state === "half_open";

      try {
        const result = await fn();

        if (state.state !== "closed") {
          logWarn(`bundle-mcp: circuit closing for "${key}" after successful probe`);
        }
        state.state = "closed";
        state.consecutiveFailures = 0;
        state.lastSuccessAt = now();

        return result;
      } catch (error) {
        state.consecutiveFailures += 1;
        state.lastFailureAt = now();

        if (wasHalfOpen || state.consecutiveFailures >= failureThreshold) {
          const previousState = state.state;
          state.state = "open";
          state.openedAt = now();
          state.nextProbeAt = state.openedAt + recoveryTimeoutMs;
          if (previousState !== "open") {
            logWarn(
              `bundle-mcp: circuit opening for "${key}" after ${state.consecutiveFailures} failure(s)`,
            );
          }
        }

        throw error;
      }
    },

    getSnapshot(): McpCircuitBreakerSnapshot {
      return {
        enabled,
        observeOnly,
        states: Array.from(states.values(), (s) => Object.assign({}, s)),
        wouldBlockCount,
      };
    },
  };
}

// ---- Budget ledger ----

type BudgetResolvedOptions = {
  enabled: boolean;
  observeOnly: boolean;
  warnAfterCallsPerSession?: number;
  warnAfterWeightedCostPerSession?: number;
  warnAfterIrreversibleCallsPerSession?: number;
  burstWindowMs: number;
  warnAfterCallsPerBurstWindow?: number;
};

function resolveBudgetOptions(cfg?: McpRuntimeGuardrailsConfig): BudgetResolvedOptions {
  const b = cfg?.budget;
  return {
    enabled: b?.enabled !== false,
    observeOnly: true,
    warnAfterCallsPerSession: b?.warnAfterCallsPerSession,
    warnAfterWeightedCostPerSession: b?.warnAfterWeightedCostPerSession,
    warnAfterIrreversibleCallsPerSession: b?.warnAfterIrreversibleCallsPerSession,
    burstWindowMs: b?.burstWindowMs ?? 60_000,
    warnAfterCallsPerBurstWindow: b?.warnAfterCallsPerBurstWindow,
  };
}

export type ToolRuntimeBudgetLedger = {
  beforeCall(params: { serverName: string; toolName: string; annotation: ToolRuntimeAnnotation }): {
    warningKeys: string[];
  };
  afterCall(params: {
    serverName: string;
    toolName: string;
    annotation: ToolRuntimeAnnotation;
    ok: boolean;
  }): { warningKeys: string[] };
  getSnapshot(): McpBudgetLedgerSnapshot;
};

export function createToolRuntimeBudgetLedger(opts: {
  cfg?: McpRuntimeGuardrailsConfig;
  now?: () => number;
}): ToolRuntimeBudgetLedger {
  const options = resolveBudgetOptions(opts.cfg);
  const now = opts.now ?? Date.now;
  let totalCalls = 0;
  let totalWeightedCost = 0;
  let irreversibleCalls = 0;
  const callsByKey = new Map<string, number>();
  const burstTimestampsByKey = new Map<string, number[]>();
  const globalBurstTimestamps: number[] = [];
  const warningsEmittedSet = new Set<string>();
  const warningsEmitted: string[] = [];

  function pruneWindow(timestamps: number[], nowMs: number, windowMs: number): void {
    const cutoff = nowMs - windowMs;
    let i = 0;
    while (i < timestamps.length && timestamps[i] <= cutoff) {
      i++;
    }
    if (i > 0) {
      timestamps.splice(0, i);
    }
  }

  function emitWarning(warningKey: string, message: string): string[] {
    if (warningsEmittedSet.has(warningKey)) {
      return [];
    }
    warningsEmittedSet.add(warningKey);
    warningsEmitted.push(warningKey);
    logWarn(`bundle-mcp: budget warning [${warningKey}]: ${message}`);
    return [warningKey];
  }

  return {
    beforeCall() {
      return { warningKeys: [] };
    },

    afterCall({ serverName, toolName, annotation }) {
      if (!options.enabled) {
        return { warningKeys: [] };
      }

      const key = `${serverName}::${toolName}`;
      const nowMs = now();
      const newWarnings: string[] = [];

      totalCalls += 1;
      callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);

      totalWeightedCost += annotation.costWeight;

      if (annotation.irreversible) {
        irreversibleCalls += 1;
      }

      // Burst window tracking
      if (!burstTimestampsByKey.has(key)) {
        burstTimestampsByKey.set(key, []);
      }
      const keyTs = burstTimestampsByKey.get(key)!;
      pruneWindow(keyTs, nowMs, options.burstWindowMs);
      keyTs.push(nowMs);

      pruneWindow(globalBurstTimestamps, nowMs, options.burstWindowMs);
      globalBurstTimestamps.push(nowMs);

      // Session call threshold
      if (
        options.warnAfterCallsPerSession != null &&
        totalCalls >= options.warnAfterCallsPerSession
      ) {
        newWarnings.push(
          ...emitWarning(
            `calls_per_session:${options.warnAfterCallsPerSession}`,
            `total MCP calls reached ${totalCalls} (threshold: ${options.warnAfterCallsPerSession})`,
          ),
        );
      }

      // Session weighted cost threshold
      if (
        options.warnAfterWeightedCostPerSession != null &&
        totalWeightedCost >= options.warnAfterWeightedCostPerSession
      ) {
        newWarnings.push(
          ...emitWarning(
            `weighted_cost_per_session:${options.warnAfterWeightedCostPerSession}`,
            `total weighted cost reached ${totalWeightedCost} (threshold: ${options.warnAfterWeightedCostPerSession})`,
          ),
        );
      }

      // Irreversible call threshold
      if (
        options.warnAfterIrreversibleCallsPerSession != null &&
        annotation.irreversible &&
        irreversibleCalls >= options.warnAfterIrreversibleCallsPerSession
      ) {
        newWarnings.push(
          ...emitWarning(
            `irreversible_calls:${options.warnAfterIrreversibleCallsPerSession}:${key}`,
            `irreversible call to "${key}" (total irreversible: ${irreversibleCalls})`,
          ),
        );
      }

      // Burst window threshold
      if (
        options.warnAfterCallsPerBurstWindow != null &&
        globalBurstTimestamps.length >= options.warnAfterCallsPerBurstWindow
      ) {
        newWarnings.push(
          ...emitWarning(
            `burst_calls:${options.warnAfterCallsPerBurstWindow}`,
            `${globalBurstTimestamps.length} MCP calls in burst window (threshold: ${options.warnAfterCallsPerBurstWindow})`,
          ),
        );
      }

      return { warningKeys: newWarnings };
    },

    getSnapshot(): McpBudgetLedgerSnapshot {
      return {
        enabled: options.enabled,
        observeOnly: options.observeOnly,
        totalCalls,
        totalWeightedCost,
        irreversibleCalls,
        callsByKey: Object.fromEntries(callsByKey.entries()),
        warningsEmitted: [...warningsEmitted],
      };
    },
  };
}

// ---- Combined guardrails facade ----

export type McpRuntimeGuardrails = {
  circuitBreaker: McpToolCircuitBreaker;
  budgetLedger: ToolRuntimeBudgetLedger;
  resolveAnnotation(serverName: string, toolName: string): ToolRuntimeAnnotation;
  getSnapshot(): McpRuntimeGuardrailSnapshot;
};

export function createMcpRuntimeGuardrails(opts: {
  cfg?: McpRuntimeGuardrailsConfig;
  now?: () => number;
  /** For tests only: disable observe-only so enforcement can be exercised. */
  enforceForTesting?: boolean;
}): McpRuntimeGuardrails {
  const circuitBreaker = createMcpToolCircuitBreaker(opts);
  const budgetLedger = createToolRuntimeBudgetLedger(opts);
  const invalidAnnotationWarnedKeys = new Set<string>();

  return {
    circuitBreaker,
    budgetLedger,
    resolveAnnotation(serverName, toolName) {
      return resolveToolAnnotation(
        serverName,
        toolName,
        opts.cfg?.tools,
        invalidAnnotationWarnedKeys,
      );
    },
    getSnapshot(): McpRuntimeGuardrailSnapshot {
      return {
        circuitBreaker: circuitBreaker.getSnapshot(),
        budget: budgetLedger.getSnapshot(),
      };
    },
  };
}
