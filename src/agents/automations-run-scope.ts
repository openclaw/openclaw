/**
 * The automations scope a cron-runner turn's tools get. Scheduled occurrences and
 * ingress turns (hook and channel join introduction) read it from their admitted
 * execution context.
 */
import {
  readScheduledAutomationsSelfJobId,
  readScheduledIngressAutomationsScope,
  readScheduledOccurrenceAutomationsScope,
} from "../cron/execution-context-registry.js";
import type { OperationalRunInstanceRef } from "./operational-run-instance.js";

type AutomationsRunScope = Readonly<{
  /** Restricts the automations tool to this job's self-scoped actions. */
  selfJobId?: string;
  /** Set when the turn must get no automations tool at all. */
  denied: boolean;
}>;

/** Resolves the automations scope for one tool construction. */
export function resolveAutomationsRunScope(
  options:
    | Readonly<{
        trigger?: string;
        jobId?: string;
        operationalRunInstance?: OperationalRunInstanceRef;
      }>
    | undefined,
): AutomationsRunScope {
  // Admission owns job identity even when a session continuation omits its
  // diagnostic jobId or trigger projection.
  const scope =
    readScheduledOccurrenceAutomationsScope(options) ??
    readScheduledIngressAutomationsScope(options);
  if (scope) {
    const selfJobId = readScheduledAutomationsSelfJobId(scope);
    return selfJobId ? { selfJobId, denied: false } : { denied: true };
  }
  const jobId = options?.jobId?.trim();
  if (!jobId || (options?.trigger !== "event" && options?.trigger !== "cron")) {
    return { denied: false };
  }
  // Without admission, cron stays restricted and ingress gets no tool.
  return options.trigger === "cron" ? { selfJobId: jobId, denied: false } : { denied: true };
}
