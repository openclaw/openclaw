/**
 * The automations scope a cron-runner turn's tools get. Ingress turns (hook and
 * channel join introduction) read it from their admitted execution context;
 * scheduled runs keep their job id until they read the context too.
 */
import { readScheduledIngressAutomationsScope } from "../cron/execution-context-registry.js";
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
  if (options?.trigger === "event" && jobId) {
    // The context owns an ingress turn's scope. A turn whose context was not
    // admitted gets no automations tool rather than an unscoped one.
    const scope = readScheduledIngressAutomationsScope(options);
    return scope?.scope === "self" ? { selfJobId: scope.jobId, denied: false } : { denied: true };
  }
  return options?.trigger === "cron" && jobId
    ? { selfJobId: jobId, denied: false }
    : { denied: false };
}
