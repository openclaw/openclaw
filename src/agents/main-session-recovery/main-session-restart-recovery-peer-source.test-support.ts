import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../gateway/agent-turn/agent-run-user-turn.js";
import { captureAgentTurnPrincipal } from "../../gateway/agent-turn/principal.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import {
  readSessionSendDelivery,
  type SessionSendDeliveryEndpoint,
} from "../../gateway/session-send-delivery.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import type { RequesterOrigin } from "../requester-origin.js";
import { prepareSessionsSendCommunication } from "../tools/sessions-send-communication.js";

/** Persist the real accepted peer envelope, then leave only its interrupted durable input. */
export async function seedConsumedPeerRestartInput(params: {
  cfg: OpenClawConfig;
  source: SessionSendDeliveryEndpoint & { storePath: string };
  target: SessionSendDeliveryEndpoint & { storePath: string };
  runId: string;
  requesterOrigin?: RequesterOrigin;
}) {
  const { cfg, source, target, runId } = params;
  const message = "Complete the saved peer task.";
  const provenance = {
    kind: "inter_session" as const,
    sourceTool: "sessions_send",
    sourceSessionKey: source.sessionKey,
  };
  await replaceSessionEntry(source, {
    sessionId: source.sessionId,
    lifecycleRevision: source.lifecycleRevision,
    updatedAt: 1,
  });
  const targetEntry = {
    sessionId: target.sessionId,
    lifecycleRevision: target.lifecycleRevision,
    permissionMode: "full" as const,
    updatedAt: 1,
  };
  await replaceSessionEntry(target, targetEntry);
  const receiver = vi.fn(async () => {
    const turn = await prepareAgentRunUserTurn({
      assertCurrent() {},
      onUserTurnMediaPersisted() {},
      request: { message, idempotencyKey: runId, deliver: false },
      cfg,
      sessionEntry: targetEntry,
      resolvedSessionKey: target.sessionKey,
      admittedSessionId: target.sessionId,
      activeSessionAgentId: target.agentId,
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: true,
      message,
      effectiveTranscriptInputText: message,
      inputProvenance: provenance,
      images: [],
      offloadedRefs: [],
      runId,
      client: params.requesterOrigin
        ? captureAgentTurnPrincipal(
            createSyntheticPluginRuntimeClient({
              agentToolCaller: {
                agentId: source.agentId,
                sessionKey: source.sessionKey,
                requesterOrigin: params.requesterOrigin,
              },
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
      await releasePreparedAgentRunUserTurn(turn);
    }
    return { runId, status: "accepted" };
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const endpoint = async (expected: SessionSendDeliveryEndpoint) => {
    const loaded = await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: expected.sessionKey,
      agentId: expected.agentId,
      assertActive() {},
      projection: "full",
    });
    return {
      agentId: loaded.agentId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.readSource?.path ?? loaded.storePath,
      entry: loaded.store[loaded.canonicalKey],
    };
  };
  const communication = await withPluginRuntimeGatewayContextResolver(
    () => context,
    async () =>
      prepareSessionsSendCommunication({
        config: cfg,
        source: await endpoint(source),
        target: await endpoint(target),
        message,
        inputProvenance: provenance,
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
        message,
        inputProvenance: provenance,
        idempotencyKey: runId,
      },
    });
  } finally {
    communication.close();
  }
  const accepted = await readPendingInputSource(target, `${runId}:user`, false);
  // Standalone input promotion removes its queue row; committed bytes retain its source.
  expect(accepted?.snapshot.pending).toBeUndefined();
  const savedMessage = expectDefined(accepted?.snapshot.committed, "accepted peer input");
  expect(readSessionSendDelivery(savedMessage)).toMatchObject({
    runId,
    source: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      lifecycleRevision: source.lifecycleRevision,
    },
    target: { sessionKey: target.sessionKey, sessionId: target.sessionId },
  });
  await updateSessionEntry(target, (entry) => ({
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
  return { receiver, originalTranscript: await loadTranscriptEvents(target) };
}
