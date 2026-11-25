/**
 * The automations scope a cron-runner turn's tools get. Scheduled occurrences and
 * ingress turns (hook and channel join introduction) read it from their admitted
 * execution context; a scheduled run never starts without one.
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
  options: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): AutomationsRunScope {
  const scope =
    readScheduledOccurrenceAutomationsScope(options) ??
    readScheduledIngressAutomationsScope(options);
  if (!scope) {
    return { denied: false };
  }
  const selfJobId = readScheduledAutomationsSelfJobId(scope);
  return selfJobId ? { selfJobId, denied: false } : { denied: true };
}
