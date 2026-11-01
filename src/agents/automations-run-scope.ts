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
  const jobId = options?.jobId?.trim();
  if (!jobId || (options?.trigger !== "event" && options?.trigger !== "cron")) {
    return { denied: false };
  }
  // The context owns the scope. An ingress turn whose context was not admitted
  // gets no automations tool rather than an unscoped one.
  const scope =
    options.trigger === "event"
      ? readScheduledIngressAutomationsScope(options)
      : readScheduledOccurrenceAutomationsScope(options);
  if (scope) {
    const selfJobId = readScheduledAutomationsSelfJobId(scope);
    return selfJobId ? { selfJobId, denied: false } : { denied: true };
  }
  // A cron turn built without an admitted context stays restricted to its own job.
  return options.trigger === "cron" ? { selfJobId: jobId, denied: false } : { denied: true };
}
