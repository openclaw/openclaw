import { captureOperatorToolGatewayContinuationContext } from "../gateway/server-plugin-in-process-dispatch.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import {
  assertAgentHarnessCompletionScope,
  type AgentHarnessCompletionScope,
} from "./agent-harness-completion-scope.js";
import { loadRequesterSessionEntry } from "./subagents/announce/subagent-announce-delivery.js";

/** A host-issued hold on one requester's accepted completion work, never arbitrary tools. */
export type AgentHarnessCompletionCustody = {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  retain(): AgentHarnessCompletionCustody;
  /** End native execution custody after the native terminal handoff, without losing delivery authority. */
  settleExecution(): void;
  release(): void;
};

type CompletionOwner = {
  scope: AgentHarnessCompletionScope;
  run: <T>(run: () => T) => T;
  emit: (run: () => void) => void;
};
const registryKey = Symbol.for("openclaw.agentHarnessCompletionCustody.registry");
// SAFETY: This module owns the process-global symbol and initializes only this typed WeakMap.
const globalRegistry = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<AgentHarnessCompletionCustody, CompletionOwner>;
};
const owners = (globalRegistry[registryKey] ??= new WeakMap());

function getCompletionOwner(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessCompletionScope,
) {
  const owner = owners.get(custody);
  const expected = owner && getGatewayContextResolver(owner.scope);
  const actual = getGatewayContextResolver(scope);
  if (
    !owner ||
    owner.scope.requesterSessionKey !== scope.requesterSessionKey ||
    owner.scope.requesterAgentId !== scope.requesterAgentId ||
    (expected && getCanonicalGatewayContextResolver(expected)) !==
      (actual && getCanonicalGatewayContextResolver(actual))
  ) {
    throw new Error("Harness completion custody does not own this requester");
  }
  return owner;
}

/** Retains admitted completion work for this exact physical requester lifecycle. */
export function captureAgentHarnessCompletionCustody(
  scope: AgentHarnessCompletionScope,
): Promise<AgentHarnessCompletionCustody | undefined> {
  assertAgentHarnessCompletionScope(scope);
  const entry = loadRequesterSessionEntry(scope.requesterSessionKey, scope.requesterAgentId).entry;
  const expected = { sessionId: entry?.sessionId, lifecycleRevision: entry?.lifecycleRevision };
  return captureAgentHarnessCompletionCustodyOwner(scope, () => {
    const current = loadRequesterSessionEntry(
      scope.requesterSessionKey,
      scope.requesterAgentId,
    ).entry;
    if (
      current?.sessionId !== expected.sessionId ||
      current?.lifecycleRevision !== expected.lifecycleRevision
    ) {
      throw new Error("Harness completion requester lifecycle was replaced");
    }
  });
}

/** Capture during admission; assignment/recovery owners retain their own holds before yielding. */
async function captureAgentHarnessCompletionCustodyOwner(
  scopeInput: AgentHarnessCompletionScope,
  assertRequesterCurrent: () => void,
): Promise<AgentHarnessCompletionCustody | undefined> {
  const scope = assertAgentHarnessCompletionScope(scopeInput);
  const resolver = getGatewayContextResolver(scope);
  const preparation = resolver
    ? withPluginRuntimeGatewayContextResolver(
        resolver,
        captureOperatorToolGatewayContinuationContext,
      )
    : captureOperatorToolGatewayContinuationContext();
  if (!preparation) {
    return undefined;
  }
  const root = retainGatewayRootWorkAdmissionContinuationScope();
  const captured = await preparation.catch((error: unknown) => {
    root?.release();
    throw error;
  });
  const releaseRoot = () => root?.release();
  captured.signal.addEventListener("abort", releaseRoot, { once: true });
  let references = 0;
  let executions = 0;
  const retain = (settled = false): AgentHarnessCompletionCustody => {
    captured.signal.throwIfAborted();
    references += 1;
    if (!settled) {
      executions += 1;
    }
    const lifetime = new AbortController();
    let executionSettled = settled;
    const settleExecution = () => {
      if (!executionSettled) {
        executionSettled = true;
        if (--executions === 0) {
          captured.signal.removeEventListener("abort", releaseRoot);
          releaseRoot();
        }
      }
    };
    const assertCurrent = () => {
      lifetime.signal.throwIfAborted();
      captured.signal.throwIfAborted();
      assertRequesterCurrent();
    };
    const custody: AgentHarnessCompletionCustody = {
      signal: AbortSignal.any([lifetime.signal, captured.signal]),
      isCurrent: () => isAgentHarnessCompletionCustodyCurrent(custody, scope),
      retain() {
        assertCurrent();
        return retain(executionSettled);
      },
      settleExecution,
      release() {
        if (lifetime.signal.aborted) {
          return;
        }
        lifetime.abort(new Error("Harness completion custody was released"));
        settleExecution();
        if (--references === 0) {
          captured.release();
        }
      },
    };
    owners.set(custody, {
      scope,
      run(run) {
        assertCurrent();
        return !executionSettled && root
          ? root.runSync(() => captured.run(run))
          : captured.run(run);
      },
      emit(run) {
        assertCurrent();
        if (executionSettled) {
          throw new Error("Harness execution custody was settled");
        }
        captured.run(() => (root ? root.runSync(run) : run()));
      },
    });
    return custody;
  };
  try {
    captured.assertCurrent();
    assertRequesterCurrent();
    return retain();
  } catch (error) {
    root?.release();
    captured.release();
    throw error;
  }
}

/** Binds activity to one live native assignment, not a persisted Tasks projection. */
export function createAgentHarnessCompletionEventSink(params: {
  scope: AgentHarnessCompletionScope;
  completionCustody: AgentHarnessCompletionCustody;
  runId: string;
  isSourceCurrent: () => boolean;
}): (event: Pick<Parameters<typeof emitAgentEvent>[0], "stream" | "data">) => void {
  const scope = assertAgentHarnessCompletionScope(params.scope);
  const owner = getCompletionOwner(params.completionCustody, scope);
  const runId = params.runId.trim();
  if (!runId) {
    throw new Error("Harness native event assignment requires a run ID");
  }
  const isSourceCurrent = params.isSourceCurrent;
  const generation = getAgentEventLifecycleGeneration();
  return (event) =>
    owner.emit(() => {
      if (!isSourceCurrent()) {
        throw new Error("Harness native event assignment was replaced");
      }
      emitAgentEvent({
        stream: event.stream,
        data: event.data,
        runId,
        agentId: scope.requesterAgentId,
        lifecycleGeneration: generation,
      });
    });
}

/** Only the completion SDK can enter retained authority; plugins cannot execute a callback in it. */
export function runWithAgentHarnessCompletionCustody<T>(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessCompletionScope,
  run: () => T,
): T {
  const owner = getCompletionOwner(custody, scope);
  return owner.run(run);
}

/** Revalidate the retained source at asynchronous delivery effect boundaries. */
export function isAgentHarnessCompletionCustodyCurrent(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessCompletionScope,
): boolean {
  try {
    return getCompletionOwner(custody, scope).run(() => true);
  } catch {
    return false;
  }
}
