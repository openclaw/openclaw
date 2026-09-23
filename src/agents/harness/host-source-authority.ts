import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  bindOperatorModelExecution,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Acquires original-source model authority while the issuing host is active. */
export function bindHarnessModelExecution(
  admittedRunContext: AdmittedRunContext,
  model: ModelRef | undefined,
  assertActive: () => void,
): ReturnType<NonNullable<AgentHarnessHostCapabilities["bindModelExecution"]>> {
  assertActive();
  return bindOperatorModelExecution(readAdmittedRunOperatorAuthority(admittedRunContext), model);
}

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
  nativeModelPolicySupported = false,
): ReturnType<NonNullable<AgentHarnessHostCapabilities["retainSourceAuthority"]>> {
  assertActive();
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  const source = readAdmittedRunOperatorAuthority(admittedRunContext);
  if (!source) {
    return undefined;
  }
  const modelExecution = nativeModelPolicySupported
    ? undefined
    : bindOperatorModelExecution(source, undefined);
  const release = nativeModelPolicySupported ? source.retain?.() : modelExecution?.release;
  const assertSourceCurrent = () => {
    if (nativeModelPolicySupported) {
      source.assertCurrent();
    } else {
      modelExecution?.assertCurrent();
    }
  };
  try {
    assertActive();
    assertSourceCurrent();
    assertActive();
  } catch (error) {
    release?.();
    throw error;
  }
  let released = false;
  let modelLifetime: AbortController | undefined;
  const lifecycle = new AbortController();
  retainedSources.add(lifecycle);
  const authoritySignal = modelExecution?.signal ?? source.signal;
  const signal = authoritySignal
    ? AbortSignal.any([authoritySignal, lifecycle.signal])
    : lifecycle.signal;
  const assertRetained = () => {
    if (released || getAgentRunLifecycleGeneration() !== lifecycleGeneration) {
      throw new Error("agent harness retained source is no longer active");
    }
    signal.throwIfAborted();
  };
  const assertCurrent = () => {
    assertRetained();
    assertSourceCurrent();
    assertRetained();
  };
  return Object.freeze({
    signal,
    assertCurrent,
    get modelPolicyRequired() {
      assertCurrent();
      const required = source.modelPolicy !== undefined;
      assertCurrent();
      return required;
    },
    get sourceIdentity() {
      assertCurrent();
      const identity = source.source;
      assertCurrent();
      return identity;
    },
    bindModelExecution: (model: ModelRef | undefined) => {
      assertCurrent();
      const binding = bindOperatorModelExecution(source, model);
      if (!binding) {
        return undefined;
      }
      const assertBindingCurrent = () => {
        binding.assertCurrent();
        assertRetained();
      };
      try {
        assertBindingCurrent();
      } catch (error) {
        binding.release();
        throw error;
      }
      modelLifetime ??= new AbortController();
      return {
        signal: AbortSignal.any([signal, modelLifetime.signal, binding.signal]),
        assertCurrent: assertBindingCurrent,
        release: binding.release,
      };
    },
    release: () => {
      if (!released) {
        released = true;
        retainedSources.delete(lifecycle);
        modelLifetime?.abort(new Error("agent harness retained source is no longer active"));
        release?.();
      }
    },
  });
}
