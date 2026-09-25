import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

export async function launchAcpChildThroughGateway(params: {
  assertDispatchCurrent?: () => void;
  attachments?: unknown[];
  childIdem: string;
  label?: string;
  lineage: Parameters<typeof buildSubagentExecutionSessionSpawnContext>[0];
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
  participantStorePath: string;
  runTimeoutSeconds: number;
  sessionKey: string;
  task: string;
}) {
  const promptedAt = Date.now();
  const response = await callSubagentGateway(
    withSubagentGatewayExecutionIdentity(
      {
        method: "agent",
        assertDispatchCurrent: params.assertDispatchCurrent,
        params: {
          message: params.task,
          sessionKey: params.sessionKey,
          idempotencyKey: params.childIdem,
          // Agent-started ACP children never write to a chat; results return to the requester.
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          acpTurnSource: "manual_spawn",
          timeout: params.runTimeoutSeconds,
          label: params.label || undefined,
          ...(params.attachments ? { attachments: params.attachments } : {}),
        },
        timeoutMs: 10_000,
      },
      {
        sessionSpawnContext: buildSubagentExecutionSessionSpawnContext(params.lineage),
        parentExecutionIdentityToken: params.parentExecutionIdentityToken,
      },
    ),
  );
  recordSessionParticipantBestEffort({
    promptedAt,
    identity: { type: "agent", id: params.lineage.parentAgentId },
    agentId: params.lineage.targetAgentId,
    sessionKey: params.sessionKey,
    storePath: params.participantStorePath,
  });
  return response;
}
