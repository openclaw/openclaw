import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

const retainedSources = resolveGlobalSingleton(
  Symbol.for("openclaw.harness.retainedSources"),
  () => new Set<AbortController>(),
);
registerAgentEventLifecycleRotationHandler("harness-retained-sources", () => {
  const retiring = [...retainedSources];
  retainedSources.clear();
  for (const controller of retiring) {
    controller.abort(new Error("agent harness retained source is no longer active"));
  }
});

/** Transfers original-source custody while the issuing foreground host is still live. */
export function retainHarnessSource(
  admittedRunContext: AdmittedRunContext,
  assertActive: () => void,
): ReturnType<NonNullable<AgentHarnessHostCapabilities["retainSourceAuthority"]>> {
  assertActive();
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  const source = readAdmittedRunOperatorAuthority(admittedRunContext);
  if (!source) {
    return undefined;
  }
  const release = source.retain?.();
  try {
    assertActive();
    source.assertCurrent();
    assertActive();
  } catch (error) {
    release?.();
    throw error;
  }
  let released = false;
  const lifecycle = new AbortController();
  retainedSources.add(lifecycle);
  const signal = source.signal
    ? AbortSignal.any([source.signal, lifecycle.signal])
    : lifecycle.signal;
  const assertRetained = () => {
    if (released || getAgentRunLifecycleGeneration() !== lifecycleGeneration) {
      throw new Error("agent harness retained source is no longer active");
    }
    signal.throwIfAborted();
  };
  return Object.freeze({
    signal,
    assertCurrent: () => {
      assertRetained();
      source.assertCurrent();
      assertRetained();
    },
    release: () => {
      if (!released) {
        released = true;
        retainedSources.delete(lifecycle);
        release?.();
      }
    },
  });
}
