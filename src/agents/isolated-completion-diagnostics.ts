import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createQueuedDiagnosticPhaseEmitter,
  emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled,
} from "../infra/diagnostic-events.js";
import { estimateAggregateUsageCost } from "../utils/usage-format.js";
import type { IsolatedCompletionResult } from "./isolated-completion-output.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
import { hasObservedModelUsage, normalizeUsage, toDiagnosticUsage } from "./usage.js";

type CompletionUsage = Pick<
  IsolatedCompletionResult,
  "provider" | "model" | "usage" | "diagnosticUsage"
>;

type CompletionUsageOwner = {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  purpose?: IsolatedCompletionPurpose;
  completionId: string;
  sessionId?: string;
  sessionKey?: string;
  runtimeKind: "cli" | "harness";
  provider: string;
  model: string;
};

/** Plugin completions finalize usage with host-plugin attribution; core callers have no other path. */
function emitIsolatedCompletionUsage(
  params: CompletionUsageOwner & { attemptId: string; result?: CompletionUsage },
): void {
  const { config, result } = params;
  if (params.purpose === "plugin-completion" || !isDiagnosticsEnabled(config)) {
    return;
  }
  const usage = normalizeUsage(result?.diagnosticUsage ?? result?.usage);
  const available = hasObservedModelUsage(usage) && usage.usageReport?.state !== "unavailable";
  const provider = result?.provider ?? params.provider;
  const model = result?.model ?? params.model;
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    agentId: params.agentId,
    provider,
    model,
    purpose: params.purpose ?? "isolated-completion",
    runtimeKind: params.runtimeKind,
    completionId: params.completionId,
    attemptId: params.attemptId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    usageReport: available ? usage.usageReport : { state: "unavailable" },
    usage: available ? toDiagnosticUsage(usage) : {},
    ...(available
      ? {
          costUsd: estimateAggregateUsageCost({
            usage,
            provider,
            model,
            config,
            agentDir: params.agentDir,
          }),
        }
      : {}),
  });
}

/** Account for a dispatched attempt even when its result is rejected or its caller has retired. */
export async function observeIsolatedCompletionUsage<T>(
  params: CompletionUsageOwner,
  run: (observe: (result: T) => void) => Promise<T>,
  project: (result: T) => CompletionUsage,
): Promise<T> {
  const attemptId = randomUUID();
  let observed = false;
  const observe = (result?: T) => {
    if (observed) {
      return;
    }
    observed = true;
    try {
      emitIsolatedCompletionUsage({
        ...params,
        attemptId,
        ...(result === undefined ? {} : { result: project(result) }),
      });
    } catch {
      // Accounting must neither authorize stale output nor replace the runtime's outcome.
    }
  };
  try {
    const result = await run(observe);
    observe(result);
    return result;
  } finally {
    // Logical abort can precede settlement. Only this actual dispatch closes its observation.
    observe();
  }
}

/** Measure runtime dispatch, not provider-wire inference or an inferred queue wait. */
export function createIsolatedCompletionDiagnostics(params: {
  config?: OpenClawConfig;
  purpose?: IsolatedCompletionPurpose;
  provider: string;
  model: string;
}) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return undefined;
  }
  const { purpose, provider, model } = params;
  const startedAt = Date.now();
  const started = performance.now();
  let config = params.config;
  let runtimeKind: "cli" | "harness" | undefined;
  let firstDispatch: number | undefined;
  let runtimeDurationMs = 0;
  let attempts = 0;
  let resultAt = started;
  let outcome: "completed" | "error" | "aborted" = "error";
  return {
    setConfig(value: OpenClawConfig) {
      config = value;
    },
    dispatch<T>(kind: "cli" | "harness", run: () => Promise<T>): Promise<T> {
      runtimeKind = kind;
      const start = performance.now();
      firstDispatch ??= start;
      attempts++;
      const finish = () => {
        runtimeDurationMs += performance.now() - start;
      };
      try {
        return run().finally(finish);
      } catch (error) {
        // Keep synchronous dispatch failures synchronous for the profile-attempt owner.
        finish();
        throw error;
      }
    },
    complete(value: "completed" | "error" | "aborted") {
      resultAt = performance.now();
      outcome = value;
    },
    settle(settlementOutcome: "completed" | "error") {
      if (!isDiagnosticsEnabled(config)) {
        return;
      }
      try {
        const settledAt = performance.now();
        emit({
          name: "isolated-completion",
          startedAt,
          endedAt: Date.now(),
          durationMs: settledAt - started,
          details: {
            purpose: purpose ?? "isolated-completion",
            provider,
            model,
            ...(runtimeKind ? { runtimeKind } : {}),
            outcome,
            settlementOutcome,
            attempts,
            // Later profile preparation remains in resultDurationMs, not runtime dispatch.
            initialPreparationMs: (firstDispatch ?? resultAt) - started,
            runtimeDurationMs,
            resultDurationMs: resultAt - started,
            settlementDurationMs: settledAt - resultAt,
          },
        });
      } catch {
        // Optional telemetry must not replace the result or prevent resource release.
      }
    },
  };
}

export type IsolatedCompletionDiagnostics = ReturnType<typeof createIsolatedCompletionDiagnostics>;
