/**
 * Guards a live turn against repeated deterministic tool failures.
 */
import type { ToolLoopDetectionConfig } from "../../config/types.tools.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ToolOutcomeObservation } from "../agent-tools.before-tool-call.js";
import { DEFAULT_TOOL_LOOP_DETECTION_CRITICAL_THRESHOLD } from "../tool-loop-detection-defaults.js";

const log = createSubsystemLogger("agents/live-tool-failure-guard");

type LiveToolFailureLoopGuardVerdict =
  | { shouldAbort: false; count: number }
  | {
      shouldAbort: true;
      detector: "live_tool_failure_loop";
      count: number;
      toolName: string;
      message: string;
    };

type LiveToolFailureLoopGuard = {
  observe: (call: ToolOutcomeObservation) => LiveToolFailureLoopGuardVerdict;
};

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveThreshold(config?: ToolLoopDetectionConfig): number {
  return asPositiveInt(config?.criticalThreshold, DEFAULT_TOOL_LOOP_DETECTION_CRITICAL_THRESHOLD);
}

function observationKey(call: ToolOutcomeObservation): string {
  return `${call.toolName}\0${call.argsHash}\0${call.resultHash}`;
}

/** Creates a stateful live deterministic-failure detector for one embedded run. */
export function createLiveToolFailureLoopGuard(
  config?: ToolLoopDetectionConfig,
  options?: { enabled?: boolean },
): LiveToolFailureLoopGuard {
  const enabled = options?.enabled ?? true;
  const threshold = resolveThreshold(config);
  let lastFailureKey: string | undefined;
  let consecutiveFailureCount = 0;

  const observe = (call: ToolOutcomeObservation): LiveToolFailureLoopGuardVerdict => {
    if (!enabled || call.presentationOnly || call.isError !== true) {
      lastFailureKey = undefined;
      consecutiveFailureCount = 0;
      return { shouldAbort: false, count: 0 };
    }
    const key = observationKey(call);
    if (key === lastFailureKey) {
      consecutiveFailureCount += 1;
    } else {
      lastFailureKey = key;
      consecutiveFailureCount = 1;
    }

    if (consecutiveFailureCount >= threshold) {
      log.error(
        `live tool failure loop: tool=${call.toolName} repeated ${consecutiveFailureCount} times with identical args+failure`,
      );
      return {
        shouldAbort: true,
        detector: "live_tool_failure_loop",
        count: consecutiveFailureCount,
        toolName: call.toolName,
        message: `CRITICAL: tool ${call.toolName} failed ${consecutiveFailureCount} times with identical arguments and identical results in one live run. Aborting to prevent runaway tool-budget exhaustion.`,
      };
    }

    return { shouldAbort: false, count: consecutiveFailureCount };
  };

  return { observe };
}

/** Error raised when a live deterministic tool-failure loop aborts a run. */
export class LiveToolFailureLoopError extends Error {
  readonly detector: "live_tool_failure_loop";
  readonly count: number;
  readonly toolName: string;

  constructor(
    message: string,
    details: {
      detector: "live_tool_failure_loop";
      count: number;
      toolName: string;
    },
  ) {
    super(message);
    this.name = "LiveToolFailureLoopError";
    this.detector = details.detector;
    this.count = details.count;
    this.toolName = details.toolName;
  }

  static fromVerdict(
    verdict: Extract<LiveToolFailureLoopGuardVerdict, { shouldAbort: true }>,
  ): LiveToolFailureLoopError {
    return new LiveToolFailureLoopError(verdict.message, {
      detector: verdict.detector,
      count: verdict.count,
      toolName: verdict.toolName,
    });
  }
}
