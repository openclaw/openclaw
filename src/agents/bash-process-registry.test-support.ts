import "./bash-process-registry.js";
import type { ProcessSession } from "./bash-process-registry.js";

type BashProcessRegistryTestApi = {
  resetProcessRegistryForTests(): void;
  buildProcessSession(
    params: Omit<ProcessSession, "output" | "aggregated" | "tail" | "pendingOutput">,
  ): ProcessSession;
  trackProcessSession(session: ProcessSession): ProcessSession;
};

// Bind cleanup to the imported registry; a later module evaluation may replace
// the global slot while existing callers still own the original instance.
const testApi = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.bashProcessRegistryTestApi")
] as BashProcessRegistryTestApi;

export function resetProcessRegistryForTests(): void {
  testApi.resetProcessRegistryForTests();
}

/** An unregistered record for unit tests of functions that take a session. */
export function buildProcessSessionForTests(
  params: Parameters<BashProcessRegistryTestApi["buildProcessSession"]>[0],
): ProcessSession {
  return testApi.buildProcessSession(params);
}

/** Track a fixture record built by `buildProcessSessionForTests`, after adjusting it. */
export function addSessionForTests(session: ProcessSession): ProcessSession {
  return testApi.trackProcessSession(session);
}
