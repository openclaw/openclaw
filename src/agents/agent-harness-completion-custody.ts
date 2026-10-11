import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { captureOperatorToolGatewayContinuationContext } from "../gateway/server-plugin-in-process-dispatch.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  getInProcessGatewayRequestContext,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  assertAgentHarnessCompletionScope,
  type AgentHarnessCompletionScope,
} from "./agent-harness-completion-scope.js";
import {
  captureRequesterSessionEntryCurrent,
  withSubagentRequesterSource,
} from "./subagents/announce/subagent-announce-delivery.runtime.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

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
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.agentHarnessCompletionCustody.registry"),
  () => new WeakMap<AgentHarnessCompletionCustody, CompletionOwner>(),
);

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
  const context = getInProcessGatewayRequestContext(
    getGatewayToolCallerIdentity()?.gatewayContextResolver ?? getGatewayContextResolver(scope),
  );
  if (!context) {
    return Promise.resolve(undefined);
  }
  const root = retainGatewayRootWorkAdmissionContinuationScope();
  const selected = getSessionActorStorageBinding({});
  if (selected && isIncognitoSessionKey(scope.requesterSessionKey)) {
    return context.trackExecution(async () => {
      let handedOff = false;
      let acquired: SessionActorStorageBinding | undefined;
      const releaseRequester = () => {
        if (acquired) {
          void acquired.actor.release().catch((error: unknown) => {
            context.logGateway.warn(
              `Harness completion requester release failed: ${formatErrorMessage(error)}`,
            );
          });
          acquired = undefined;
        }
      };
      try {
        if (selected.agentId !== scope.requesterAgentId) {
          return undefined;
        }
        let memory: SessionActorStorageBinding | undefined =
          selected.actor.target.sessionKey === scope.requesterSessionKey ? selected : undefined;
        if (!memory) {
          if (
            !selected.actor.storage.readCurrent(
              { type: "session.entry.read", input: { sessionKey: scope.requesterSessionKey } },
              selected.authority,
            )
          ) {
            return undefined;
          }
          const actor = await selected.actor.storage.acquire(scope.requesterSessionKey, {
            assertCurrent: () => selected.authority.assertCurrent(),
            assertReadable: () => selected.authority.assertCurrent(),
          });
          memory = acquired = {
            ...selected,
            actor,
          };
        }
        const requester = memory;
        const custody = await runWithSessionActorStorage(requester, () =>
          captureAgentHarnessCompletionCustodyOwner(
            scope,
            () => {
              if (!requester.actor.snapshot(requester.authority)?.entry) {
                throw new Error("Harness completion requester was closed");
              }
            },
            releaseRequester,
            root,
          ),
        );
        handedOff = custody !== undefined;
        return custody;
      } finally {
        if (!handedOff) {
          releaseRequester();
          root?.release();
        }
      }
    });
  }
  const released = createDeferredCore();
  const ready = createDeferredCore<AgentHarnessCompletionCustody | undefined>();
  let handedOff = false;
  let selectedRequester = false;
  // The Gateway joins source release after the synchronous custody handoff.
  const work = context
    .trackExecution(() =>
      withSubagentRequesterSource(
        scope.requesterSessionKey,
        scope.requesterAgentId,
        async (isCurrent) => {
          selectedRequester = isCurrent !== undefined;
          const readCurrent = captureRequesterSessionEntryCurrent(
            scope.requesterSessionKey,
            scope.requesterAgentId,
          );
          const entry = readCurrent();
          const expected = {
            sessionId: entry?.sessionId,
            lifecycleRevision: entry?.lifecycleRevision,
          };
          if (isCurrent && !entry) {
            return;
          }
          const custody = await captureAgentHarnessCompletionCustodyOwner(
            scope,
            () => {
              const current = readCurrent();
              if (
                current?.sessionId !== expected.sessionId ||
                current?.lifecycleRevision !== expected.lifecycleRevision
              ) {
                throw new Error("Harness completion requester lifecycle was replaced");
              }
            },
            () => released.resolve(),
            root,
          );
          if (custody) {
            handedOff = true;
            ready.resolve(custody);
            if (selectedRequester) {
              await released.promise;
            }
          }
        },
      ),
    )
    .finally(() => {
      // Native execution custody keeps its root until settleExecution; rejected
      // admission never enters the callback and must release its unclaimed hold.
      if (!handedOff || selectedRequester) {
        root?.release();
      }
    });
  void work.then(
    () => ready.resolve(undefined),
    (error: unknown) => {
      ready.reject(error);
      if (handedOff) {
        context.logGateway.warn(
          `Harness completion requester settlement failed: ${formatErrorMessage(error)}`,
        );
      }
    },
  );
  return ready.promise;
}

/** Capture during admission; assignment/recovery owners retain their own holds before yielding. */
async function captureAgentHarnessCompletionCustodyOwner(
  scopeInput: AgentHarnessCompletionScope,
  assertRequesterCurrent: () => void,
  releaseRequester: () => void,
  root: ReturnType<typeof retainGatewayRootWorkAdmissionContinuationScope>,
): Promise<AgentHarnessCompletionCustody | undefined> {
  const scope = assertAgentHarnessCompletionScope(scopeInput);
  const requesterTarget = {
    sessionKey: scope.requesterSessionKey,
    agentId: scope.requesterAgentId,
  };
  const memory = getSessionActorStorageBinding(requesterTarget);
  const requesterBinding = memory ? undefined : captureIncognitoSessionBinding(requesterTarget);
  const runInRequester = <T>(run: () => T): T =>
    memory
      ? runWithSessionActorStorage(memory, run)
      : requesterBinding
        ? withIncognitoSessionBinding(requesterBinding, run)
        : run();
  const resolver = getGatewayContextResolver(scope);
  const capture = () =>
    captureOperatorToolGatewayContinuationContext({
      sessionKey: scope.requesterSessionKey,
      agentId: scope.requesterAgentId,
    });
  const preparation = resolver
    ? withPluginRuntimeGatewayContextResolver(resolver, capture)
    : capture();
  if (!preparation) {
    return undefined;
  }
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
          releaseRequester();
        }
      },
    };
    owners.set(custody, {
      scope,
      run(run) {
        assertCurrent();
        return !executionSettled && root
          ? root.runSync(() => captured.run(() => runInRequester(run)))
          : captured.run(() => runInRequester(run));
      },
      emit(run) {
        assertCurrent();
        if (executionSettled) {
          throw new Error("Harness execution custody was settled");
        }
        captured.run(() => runInRequester(() => (root ? root.runSync(run) : run())));
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
