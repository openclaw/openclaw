import { AsyncLocalStorage } from "node:async_hooks";
// Resolves host-issued completion scopes for agent harness launches.
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";

// Host-issued scopes prevent plugins from fabricating requester ownership for completions.
const scopeRegistry = resolveGlobalSingleton(
  Symbol.for("openclaw.agentHarnessCompletionScope.registry"),
  () => ({
    hostIssuedScopes: new WeakSet<object>(),
    runs: new WeakMap<object, { instance: OperationalRunInstanceRef; assertCurrent: () => void }>(),
    handoffs: new WeakMap<OperationalRunInstanceRef, Map<string, () => boolean>>(),
  }),
);

export type AgentHarnessCompletionScope = {
  readonly requesterSessionKey: string;
  readonly requesterAgentId: string;
  readonly requesterOrigin?: DeliveryContext;
};

/** Creates a host-issued requester scope for agent harness completion. */
export function createAgentHarnessCompletionScope(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  gatewayContextResolver?: GatewayContextResolver;
  run?: { instance: OperationalRunInstanceRef; assertCurrent: () => void };
}): AgentHarnessCompletionScope {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("Harness completion scope requires requesterSessionKey");
  }
  const requesterAgentId =
    params.requesterAgentId?.trim() || parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (!requesterAgentId) {
    throw new Error("Harness completion scope requires an exact requester agent");
  }
  const scope: AgentHarnessCompletionScope = {
    requesterSessionKey,
    requesterAgentId,
  };
  scopeRegistry.hostIssuedScopes.add(scope);
  if (params.run) {
    scopeRegistry.runs.set(scope, params.run);
  }
  bindGatewayContextResolver(scope, params.gatewayContextResolver);
  return scope;
}

export function assertAgentHarnessCompletionScope(
  scope: AgentHarnessCompletionScope,
): AgentHarnessCompletionScope {
  if (!scopeRegistry.hostIssuedScopes.has(scope)) {
    throw new Error("Harness completion requires a host-issued scope");
  }
  return scope;
}

type HarnessCompletionSourceAdmission = {
  scope: AgentHarnessCompletionScope;
  sourceSessionKey: string;
  sourceRunId: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  assertCurrent: () => void;
};
const sourceAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.harnessCompletionSourceAdmission"),
  () => new AsyncLocalStorage<HarnessCompletionSourceAdmission>(),
);
/** The native source owner retains admission through ordinary completion delivery. */
export async function withAgentHarnessCompletionAdmission<T>(
  params: {
    scope: AgentHarnessCompletionScope;
    sourceSessionKey: string;
    sourceRunId: string;
    requesterSessionId: string;
    requesterLifecycleRevision?: string;
    isSourceCurrent: () => boolean;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const scope = assertAgentHarnessCompletionScope(params.scope);
  let active = true;
  const assertCurrent = () => {
    if (!active || !params.isSourceCurrent()) {
      throw new Error("Harness completion source owner retired");
    }
  };
  assertCurrent();
  try {
    return await sourceAdmissions.run({ ...params, scope, assertCurrent }, operation);
  } finally {
    active = false;
  }
}
export function assertHarnessCompletionSourceAdmission(params: {
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  sourceSessionKey: string;
  sourceRunId: string;
}): () => void {
  const admission = sourceAdmissions.getStore();
  if (
    !admission ||
    admission.scope.requesterSessionKey !== params.requesterSessionKey ||
    admission.scope.requesterAgentId !== params.requesterAgentId ||
    admission.requesterSessionId !== params.requesterSessionId ||
    admission.requesterLifecycleRevision !== params.requesterLifecycleRevision ||
    admission.sourceSessionKey !== params.sourceSessionKey ||
    admission.sourceRunId !== params.sourceRunId
  ) {
    throw new Error("Harness completion requires exact host-issued source admission");
  }
  admission.assertCurrent();
  return admission.assertCurrent;
}

/** Called only after the completion owner validates retained custody. */
export function recordAgentHarnessCompletionHandoff(
  scope: AgentHarnessCompletionScope,
  runId: string,
  isCurrent: () => boolean,
): void {
  assertAgentHarnessCompletionScope(scope);
  const run = scopeRegistry.runs.get(scope);
  if (!run) {
    return;
  }
  run.assertCurrent();
  const handoffs = scopeRegistry.handoffs.get(run.instance) ?? new Map<string, () => boolean>();
  handoffs.set(runId, () => {
    try {
      run.assertCurrent();
      return isCurrent();
    } catch {
      return false;
    }
  });
  scopeRegistry.handoffs.set(run.instance, handoffs);
}

export function hasAgentHarnessCompletionHandoff(instance: OperationalRunInstanceRef): boolean {
  return [...(scopeRegistry.handoffs.get(instance)?.values() ?? [])].some((isCurrent) =>
    isCurrent(),
  );
}
