import { readGitHubPublicationFact } from "../../../gateway/github-publication-discovery.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { agentHarnessExposesOpenClawTools } from "../../harness/tool-surface.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Prepare Gateway tools once at the shared dispatch boundary, including internal continuations. */
export function withPreparedEmbeddedGatewayTools<T>(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "admittedRunContext"
    | "cronCreatorAuthorityCapability"
    | "messageChannel"
    | "messageProvider"
    | "currentMessagingTarget"
    | "currentChannelId"
    | "agentAccountId"
    | "currentThreadTs"
    | "sessionId"
    | "disableTools"
    | "sessionPersistence"
    | "githubPublicationAvailable"
  > & { agentId: string; sessionKey: string; agentHarnessId: string },
  run: () => Promise<T>,
): Promise<T> {
  const callerIdentity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: attempt.admittedRunContext,
    cronAuthorityCheck: attempt.cronCreatorAuthorityCapability?.isCurrent,
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceLocal:
      (!attempt.messageChannel &&
        !attempt.messageProvider &&
        attempt.cronCreatorAuthorityCapability?.callerOrigin.kind === "local") ||
      undefined,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  return withGatewayToolCallerIdentity(callerIdentity, () => {
    const resolveGatewayContext = getGatewayContextResolver(attempt.admittedRunContext);
    const gateway = resolveGatewayContext?.();
    if (
      !attempt.disableTools &&
      attempt.sessionPersistence !== "detached" &&
      agentHarnessExposesOpenClawTools(attempt.agentHarnessId) &&
      gateway &&
      !gateway.localEmbedded
    ) {
      attempt.githubPublicationAvailable = readGitHubPublicationFact({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: attempt.agentId,
      }).available;
    }
    return run();
  });
}
