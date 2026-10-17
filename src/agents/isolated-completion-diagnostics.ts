import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createQueuedDiagnosticPhaseEmitter,
  isDiagnosticsEnabled,
} from "../infra/diagnostic-events.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";

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
