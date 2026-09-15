import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";

type GitHubAvailabilityInput = Pick<
  PreparedEmbeddedRunInput,
  "runParams" | "resolvedSessionKey" | "workspaceResolution"
>;

/** Shared chat/background preparation; availability never replaces live authorization. */
export async function prepareGitHubAvailability(
  input: GitHubAvailabilityInput,
  sessionId: string,
  attempt: { isCurrent(): boolean },
): Promise<boolean | undefined> {
  const { runParams: params, resolvedSessionKey, workspaceResolution } = input;
  const supplied = params.githubPublicationAvailable;
  // An unadmitted or standalone caller must not discover a nearby Gateway.
  const resolveGatewayContext = params.admittedRunContext
    ? getGatewayContextResolver(params.admittedRunContext)
    : undefined;
  const gatewayContext = resolveGatewayContext?.();
  if (
    supplied !== undefined ||
    !gatewayContext ||
    gatewayContext.localEmbedded ||
    !resolvedSessionKey ||
    params.disableTools ||
    params.modelRun ||
    params.promptMode === "none"
  ) {
    return supplied;
  }
  const { prepareGitHubPublicationAvailability } =
    await import("../../../gateway/github-publication-availability.js");
  return await prepareGitHubPublicationAvailability({
    agentId: workspaceResolution.agentId,
    sessionId,
    sessionKey: resolvedSessionKey,
    assertCurrent: () => resolveGatewayContext?.() === gatewayContext && attempt.isCurrent(),
  });
}
