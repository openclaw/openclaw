import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { subagentCompletionSourceId } from "../registry/subagent-controller-inputs.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { captureRequesterFollowupContinuationCaller } from "../requester-cron-authority.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";

/** Reserves one followup source against the durable registry row that owns it. */
export async function reserveSubagentControllerSource(
  entry: SubagentRunRecord,
  reservationId: string,
  protocolRunId?: string,
  continuationCaller?: SessionControllerInput["continuationCaller"],
  options: {
    replaceInactiveTarget?: boolean;
    requester?: Awaited<ReturnType<typeof loadRequesterSessionEntry>>;
  } = {},
): Promise<SessionControllerInput | undefined> {
  const requester =
    options.requester ??
    (await loadRequesterSessionEntry(entry.requesterSessionKey, entry.requesterAgentId));
  if (!requester.entry?.sessionId || !requester.storePath) {
    return undefined;
  }
  const target = captureSessionTarget({
    storeScope: requester.storePath,
    physicalStorePath: requester.physicalStorePath,
    sessionKey: requester.canonicalKey,
    aliases: [entry.requesterSessionKey],
    agentId: requester.agentId,
    incarnation: requester.entry.sessionId,
  });
  return withPluginRuntimeGatewayContextResolver(getGatewayContextResolver(entry), () =>
    reserveSessionControllerSource(requester.canonicalKey, {
      reservationId,
      protocolRunId,
      replaceInactiveTarget: options.replaceInactiveTarget,
      continuationCaller,
      policy: { mode: "followup" },
      target,
    }),
  );
}

export const reserveSubagentCompletionControllerSource = (
  entry: SubagentRunRecord,
  protocolRunId?: string,
  options: Parameters<typeof reserveSubagentControllerSource>[4] = {},
) =>
  reserveSubagentControllerSource(
    entry,
    subagentCompletionSourceId(entry),
    protocolRunId,
    captureRequesterFollowupContinuationCaller(
      entry,
      protocolRunId ??
        buildAnnounceIdempotencyKey(
          buildAnnounceIdFromChildRun({
            childSessionKey: entry.childSessionKey,
            childRunId: entry.runId,
          }),
        ),
    ),
    options,
  );
