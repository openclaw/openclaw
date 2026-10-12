import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ReplyTurnParticipants } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import {
  getAgentRunLifecycleGeneration,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  assertAdmittedRunOperatorAuthority,
  bindOperatorModelExecution,
  captureAdmittedRunActiveAssertion,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  captureGatewayToolReceiptAssertion,
  type getGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Keep the original run and caller predicates attached to every host capability. */
export function bindHarnessHostSourceAuthority(params: {
  attempt: {
    admittedRunContext: AdmittedRunContext;
    runId: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
  };
  delegatedAuthority: AgentRunDelegatedAuthority;
  sourceCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
  isActive: () => boolean;
  isGatewayCurrent: () => boolean;
  inactiveError: (message: string) => Error;
}) {
  const { attempt, sourceCaller, inactiveError } = params;
  const operationalRunInstance = attempt.admittedRunContext.operationalRunInstance;
  const admittedSource = captureAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    params.delegatedAuthority,
  );
  const assertAdmitted = composeSessionSourceAssertion([admittedSource], (assertSource) => {
    if (
      !params.isActive() ||
      !admittedSource ||
      attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance
    ) {
      throw inactiveError("agent harness host capability is no longer active");
    }
    try {
      assertSource();
    } catch {
      throw inactiveError("agent harness host capability is no longer active");
    }
    if (!params.isGatewayCurrent()) {
      throw inactiveError("agent harness host capability is no longer active");
    }
  });
  const receipt = sourceCaller?.receiptAuthority;
  const assertReceipt =
    receipt &&
    captureGatewayToolReceiptAssertion(
      receipt,
      "agent harness host capability lost its source execution claim",
    );
  const assertCaller = composeSessionSourceAssertion(
    [captureExternalSessionCommitGuard(assertReceipt)],
    (assertSource) => {
      if (
        (sourceCaller &&
          (sourceCaller.agentId !== attempt.agentId ||
            sourceCaller.sessionKey !== attempt.sessionKey)) ||
        (sourceCaller?.workerTurnClaim &&
          (sourceCaller.workerTurnClaim.sessionId !== attempt.sessionId ||
            sourceCaller.workerTurnClaim.runId !== attempt.runId)) ||
        (sourceCaller?.workerTurnClaim && !receipt)
      ) {
        throw new Error("agent harness host capability lost its source execution claim");
      }
      assertSource();
    },
  );
  return composeSessionSourceAssertion([assertAdmitted, assertCaller]);
}

/** Native delegation cannot select a person, so its live turn must remain unambiguous. */
export function bindHarnessNativeSpawnAuthority(
  participants: ReplyTurnParticipants | undefined,
  assertActive: () => void,
): AgentHarnessHostCapabilities["assertNativeSubagentSpawnAllowed"] {
  return participants
    ? () => {
        assertActive();
        participants.resolve()?.assertCurrent();
      }
    : undefined;
}

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

/** Host-only original source; an explicit undefined operator identifies System work. */
export type AgentHarnessCompactionSourceAuthority = Readonly<{
  assertActive: SessionSourceAssertion;
  prepareDispatch?: () => Promise<void>;
  operatorAuthority: AdmittedRunOperatorAuthority | undefined;
}>;

export function assertCompactionSource(
  source: AgentHarnessCompactionSourceAuthority | undefined,
): asserts source is AgentHarnessCompactionSourceAuthority {
  if (!source || !Object.hasOwn(source, "operatorAuthority")) {
    throw new Error("Compaction requires its original host source authority");
  }
  source.assertActive();
  if (source.operatorAuthority !== undefined) {
    assertAdmittedRunOperatorAuthority(source.operatorAuthority);
    source.operatorAuthority.assertCurrent();
  }
}

/** Retains the existing issuer through queueing; the compaction work owner releases it. */
export function retainAgentHarnessCompactionSource(
  source: AgentHarnessCompactionSourceAuthority | undefined,
): () => void {
  assertCompactionSource(source);
  const release = source.operatorAuthority?.retain?.();
  try {
    assertCompactionSource(source);
  } catch (error) {
    release?.();
    throw error;
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      release?.();
    }
  };
}
