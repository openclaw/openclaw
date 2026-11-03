import { captureSessionPendingInputWorkerCustody } from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";
import { createAgentRunPluginReloadAbortError } from "./run-termination.js";

type Owner = {
  operation: ReplyOperation;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  generation: PreparedModelRuntimePluginGeneration;
};
type Membership = Omit<Owner, "generation"> & {
  instances: ReadonlySet<PluginInstanceHandle>;
  sourceInputKeys: string[];
};
const membership = new WeakMap<ReplyOperation, Membership>();

/** The run's physical lease, not a late native attachment or diagnostic string, owns membership. */
export function registerPluginReloadRunOwner(
  source: Pick<Owner, "runId" | "sessionId" | "sessionKey"> & { replyOperation?: ReplyOperation },
  agentId: string,
  generation: PreparedModelRuntimePluginGeneration | undefined,
): (() => void) | undefined {
  const operation = source.replyOperation;
  if (!operation || !generation) {
    return undefined;
  }
  const owner: Owner = {
    operation,
    runId: source.runId,
    sessionId: source.sessionId,
    sessionKey: source.sessionKey,
    agentId,
    generation,
  };
  const instances = new Set<PluginInstanceHandle>();
  for (const registry of [
    owner.generation.pluginRegistry,
    owner.generation.inboundPluginRegistry,
  ]) {
    if (registry) {
      for (const instance of collectRegistryInvocationInstances(registry)) {
        instances.add(instance);
      }
    }
  }
  const custody = captureSessionPendingInputWorkerCustody();
  const sourceInputKeys = custody
    ? (custody.facts.sources ?? [custody.facts])
        .filter(
          (input) => input.sessionId === owner.sessionId && input.sessionKey === owner.sessionKey,
        )
        .map((input) => input.idempotencyKey)
    : [];
  const current: Membership = {
    sourceInputKeys,
    operation: owner.operation,
    runId: owner.runId,
    sessionId: owner.sessionId,
    sessionKey: owner.sessionKey,
    agentId: owner.agentId,
    instances,
  };
  membership.set(owner.operation, current);
  return () => {
    if (membership.get(owner.operation) === current) {
      membership.delete(owner.operation);
    }
  };
}

/** Capture exact operations after replacement admission closes, before cancellation can reenter. */
export function capturePluginReloadRunTargets(instances: ReadonlySet<PluginInstanceHandle>) {
  return [...activeSessionOperations()].flatMap((operation) => {
    const owner = membership.get(operation);
    if (
      !owner ||
      operation.result ||
      operation.abortSignal.aborted ||
      ![...owner.instances].some((instance) => instances.has(instance))
    ) {
      return [];
    }
    const capture = captureSessionControllerStop({ operations: [operation] });
    const isBlocking = () =>
      membership.get(operation) === owner && !operation.result && !operation.abortSignal.aborted;
    return [
      {
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        sessionKey: owner.sessionKey,
        runId: owner.runId,
        sourceInputKeys: owner.sourceInputKeys,
        operation,
        isBlocking,
        interrupt: () =>
          isBlocking() &&
          stopSession({
            source: "interrupt",
            capture,
            reason: createAgentRunPluginReloadAbortError(),
          }).aborted,
      },
    ];
  });
}
export type PluginReloadRunTarget = ReturnType<typeof capturePluginReloadRunTargets>[number];

/** Keep membership until the physical prepared-runtime lease has actually disposed. */
export function ownPluginReloadRun(
  source: Pick<Owner, "runId" | "sessionId" | "sessionKey"> & {
    replyOperation?: ReplyOperation;
  },
  agentId: string,
  lease: AsyncDisposable & { pluginGeneration?: PreparedModelRuntimePluginGeneration },
): AsyncDisposable {
  const release = registerPluginReloadRunOwner(source, agentId, lease.pluginGeneration);
  if (!release) {
    return lease;
  }
  return {
    async [Symbol.asyncDispose]() {
      try {
        await lease[Symbol.asyncDispose]();
      } finally {
        release();
      }
    },
  };
}
