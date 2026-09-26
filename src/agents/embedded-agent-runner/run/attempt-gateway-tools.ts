import { prepareGitHubPublicationAvailability } from "../../../gateway/github-publication-availability.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { agentHarnessExposesOpenClawTools } from "../../harness/tool-surface.js";
import { recordExplicitSkillSelectionsForRun } from "../../skill-selection-usage.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Prepare Gateway tools once at the shared dispatch boundary, including internal continuations. */
export async function withPreparedEmbeddedGatewayTools<T>(
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
    | "explicitSkillSelections"
    | "skillsSnapshot"
  > & { agentId: string; sessionKey: string; agentHarnessId: string },
  isAttemptCurrent: () => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const callerIdentity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: attempt.admittedRunContext,
    cronAuthorityCheck: attempt.cronCreatorAuthorityCapability?.isCurrent,
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceLocal:
      !attempt.messageChannel &&
      !attempt.messageProvider &&
      attempt.cronCreatorAuthorityCapability?.callerOrigin.kind === "local"
        ? true
        : undefined,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  return withGatewayToolCallerIdentity(callerIdentity, async () => {
    const resolveGatewayContext = getGatewayContextResolver(attempt.admittedRunContext);
    const gateway = resolveGatewayContext?.();
    if (
      !attempt.disableTools &&
      attempt.sessionPersistence !== "detached" &&
      agentHarnessExposesOpenClawTools(attempt.agentHarnessId) &&
      gateway &&
      !gateway.localEmbedded
    ) {
      // Yield, compaction, and retries recheck the current session and exact live host;
      // an earlier attempt's availability must not determine its successor's tool catalog.
      const isCurrent = () => isAttemptCurrent() && resolveGatewayContext?.() === gateway;
      attempt.githubPublicationAvailable = await prepareGitHubPublicationAvailability({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: attempt.agentId,
        assertCurrent: isCurrent,
      });
      if (!isCurrent()) {
        throw new Error("GitHub tool preparation outlived its admitted Gateway run");
      }
    }
    recordExplicitSkillSelectionsForRun({
      operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
      selections: attempt.explicitSkillSelections,
      skillsSnapshot: attempt.skillsSnapshot,
    });
    return run();
  });
}
