import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import * as sessions from "../../config/sessions/session-accessor.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import * as userTurns from "../../gateway/agent-turn/agent-run-user-turn.js";
import { captureAgentTurnPrincipal } from "../../gateway/agent-turn/principal.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import * as peerDelivery from "../../gateway/session-send-delivery.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import type { RequesterOrigin } from "../requester-origin.js";
import { prepareSessionsSendCommunication } from "../tools/sessions-send-communication.js";

/** Persist the real accepted peer envelope, then leave only its interrupted durable input. */
export async function seedConsumedPeerRestartInput(params: {
  cfg: OpenClawConfig;
  source: peerDelivery.SessionSendDeliveryEndpoint & { storePath: string };
  target: peerDelivery.SessionSendDeliveryEndpoint & { storePath: string };
  runId: string;
  requesterOrigin?: RequesterOrigin;
}) {
  const { cfg, source, target, runId, requesterOrigin } = params;
  const { storePath, ...sourceIdentity } = source;
  const { agentId, sessionKey } = sourceIdentity;
  const message = "Complete the saved peer task.";
  const provenance = {
    kind: "inter_session" as const,
    sourceTool: "sessions_send",
    sourceSessionKey: sessionKey,
  };
  const input = { message, inputProvenance: provenance };
  const request = { ...input, idempotencyKey: runId };
  const sourceEntry = await sessions.replaceSessionEntry(source, {
    sessionId: source.sessionId,
    lifecycleRevision: source.lifecycleRevision,
    updatedAt: 1,
  });
  const storedTarget = await sessions.replaceSessionEntry(target, {
    sessionId: target.sessionId,
    lifecycleRevision: target.lifecycleRevision,
    permissionMode: "full",
    updatedAt: 1,
  });
  const receiver = vi.fn(async () => {
    const turn = await userTurns.prepareAgentRunUserTurn({
      assertCurrent() {},
      onUserTurnMediaPersisted() {},
      request: { message, idempotencyKey: runId, deliver: false },
      cfg,
      resolvedSessionKey: target.sessionKey,
      admittedSessionId: target.sessionId,
      activeSessionAgentId: target.agentId,
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: true,
      ...input,
      effectiveTranscriptInputText: message,
      images: [],
      offloadedRefs: [],
      runId,
      client: requesterOrigin
        ? captureAgentTurnPrincipal(
            createSyntheticPluginRuntimeClient({
              agentToolCaller: { agentId, sessionKey, requesterOrigin },
            }),
          )
        : null,
      context: createAgentTurnTestContext(),
    });
    try {
      expect(await turn.recorder!.persistApproved()).toMatchObject({ appended: true });
      await turn.recorder!.completeProcessingAsync!(
        buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
      );
    } finally {
      await userTurns.releasePreparedAgentRunUserTurn(turn);
    }
    return { runId, status: "accepted" };
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const communication = await withPluginRuntimeGatewayContextResolver(
    () => context,
    async () =>
      prepareSessionsSendCommunication({
        config: cfg,
        source: { ...sourceIdentity, storePath, entry: sourceEntry ?? undefined },
        target: { ...target, entry: storedTarget ?? undefined },
        ...input,
        allowApproval: false,
        callGateway: async <T>() => (await receiver()) as T,
      }),
  );
  try {
    await communication.callGateway({
      method: "agent",
      params: {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        ...request,
      },
    });
  } finally {
    communication.close();
  }
  const accepted = await readPendingInputSource(target, `${runId}:user`, false);
  // Standalone input promotion removes its queue row; committed bytes retain its source.
  expect(accepted?.snapshot.pending).toBeUndefined();
  const savedMessage = expectDefined(accepted?.snapshot.committed, "accepted peer input");
  expect(peerDelivery.readSessionSendDelivery(savedMessage)).toMatchObject({
    runId,
    source: sourceIdentity,
    target: { sessionKey: target.sessionKey, sessionId: target.sessionId },
  });
  await sessions.updateSessionEntry(target, (entry) => ({
    ...buildCurrentRunRestartRecoveryClaim({
      entry,
      runId,
      sourceRunId: runId,
      sourceIngress: "internal",
    }),
    lifecycleRunId: runId,
    status: "interrupted",
    abortedLastRun: true,
  }));
  return { receiver, originalTranscript: await sessions.loadTranscriptEvents(target) };
}
