import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

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

export function assertEmbeddedRouteRunsInGateway(): void {
  if (!embeddedRouteRunsInGateway()) {
    throw new Error(
      "lobster llm.invoke embedded route requires the gateway request scope; it cannot run outside the gateway process",
    );
  }
}
