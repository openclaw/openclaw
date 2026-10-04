import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  LobsterCheckpointCaller,
  LobsterCheckpointProvenance,
} from "./lobster-checkpoint-provenance.js";

/** Recorded alongside operator scopes when the host let the caller override models. */
const MODEL_OVERRIDE_AUTHORITY = "model-override";

/**
 * The embedded route spends the gateway's own model authority through the host
 * completion API, so it is only valid for work the gateway is handling. Follow
 * the established plugin runtime pattern and require the request scope the
 * gateway binds for the duration of a request, which is what the host completion
 * API authorizes against. A run outside that scope has no gateway authority to
 * spend, so it is refused rather than served by ambient credentials.
 */
function embeddedRouteRunsInGateway(): boolean {
  return Boolean(getPluginRuntimeGatewayRequestScope());
}

/**
 * Re-authorize the caller before a saved LLM answer is shown. A saved answer is
 * disclosure, so it gets the same check as a live request at the moment it is
 * returned: the gateway request must still be bound, its admitted grant is
 * rechecked, and the connection's authority must still be current.
 */
export async function authorizeSavedAnswerForCaller(): Promise<void> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope) {
    throw new Error(
      "lobster saved LLM answer requires the gateway request scope; it is not shown outside a gateway request",
    );
  }
  if (!scope.revalidate && !scope.hasCurrentClientAuthority) {
    throw new Error("lobster saved LLM answer requires a host authority checker");
  }
  scope.signal?.throwIfAborted();
  await scope.revalidate?.();
  scope.signal?.throwIfAborted();
  if (scope.hasCurrentClientAuthority && !scope.hasCurrentClientAuthority()) {
    throw new Error(
      "lobster saved LLM answer refused: the caller's authority is no longer current",
    );
  }
}

/**
 * The calling agent and the authority the current gateway request carries: its
 * operator scopes, and whether the host lets it override models. Recorded when
 * an embedded stage runs, because that stage spent exactly this authority.
 */
export function describeCurrentCaller(agentId: string | undefined): LobsterCheckpointCaller {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  const scopes = client?.connect?.scopes;
  const authority = new Set(
    Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [],
  );
  if (client?.internal?.allowModelOverride === true) {
    authority.add(MODEL_OVERRIDE_AUTHORITY);
  }
  const trimmed = agentId?.trim();
  return { ...(trimmed ? { agentId: trimmed } : {}), authority: [...authority].toSorted() };
}

/**
 * Authorize a resume before Lobster discloses or consumes what its checkpoint
 * stored. Output from an LLM stage gets the same check as a saved answer; output
 * from an embedded stage also stays with the agent it was produced for, and with
 * a caller who still holds every authority the producing caller held. A
 * checkpoint with no record cannot be shown to carry no model output, so it is
 * treated as carrying a saved answer.
 */
export async function authorizeCheckpointForCaller(
  provenance: LobsterCheckpointProvenance | undefined,
  callerAgentId: string | undefined,
): Promise<void> {
  if (provenance && !provenance.untrackedOrigin && provenance.stages.length === 0) {
    return;
  }
  await authorizeSavedAnswerForCaller();
  if (!provenance?.stages.some((stage) => stage.provider === "embedded")) {
    return;
  }
  const producer = provenance.caller;
  const current = describeCurrentCaller(callerAgentId);
  if (!producer?.agentId || producer.agentId !== current.agentId) {
    throw new Error(
      "lobster checkpoint refused: its embedded LLM output was produced for another agent",
    );
  }
  const held = new Set(current.authority);
  const missing = producer.authority.filter((entry) => !held.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `lobster checkpoint refused: the caller no longer holds ${missing.join(", ")}, which produced its embedded LLM output`,
    );
  }
}

export function assertEmbeddedRouteRunsInGateway(): void {
  if (!embeddedRouteRunsInGateway()) {
    throw new Error(
      "lobster llm.invoke embedded route requires the gateway request scope; it cannot run outside the gateway process",
    );
  }
}
