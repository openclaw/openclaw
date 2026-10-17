import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import {
  readSessionPendingInput,
  stageSessionPendingInput,
} from "../../../config/sessions/session-accessor.pending-inputs.js";
import { gatewayClientSenderFields } from "../../../gateway/server-methods/gateway-client-identity.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Retain a real accepted input across the caller's registry and Gateway replacement. */
export async function preparePrivateReplay(entry: SubagentRunRecord | undefined) {
  if (!entry) {
    return undefined;
  }
  const scope = {
    agentId: expectDefined(entry.requesterAgentId, "requester agent"),
    sessionKey: entry.requesterSessionKey,
    sessionId: expectDefined(entry.completionRequesterSessionId, "requester session"),
    storePath: expectDefined(entry.requesterStorePath, "requester store"),
  };
  const runId = `announce:v1:${entry.childSessionKey}:${entry.runId}`;
  const current = () => expectDefined(subagentRuns.get(entry.runId), "current completion source");
  const stage = () =>
    subagentRuns.runWithCompletionAuthority(current(), () =>
      stageSessionPendingInput(scope, {
        runId,
        message: buildPersistedUserTurnMessage({
          text: "Retained private child result",
          display: false,
          idempotencyKey: `${runId}:user`,
          ...gatewayClientSenderFields(getPluginRuntimeGatewayRequestScope()?.client ?? null),
          senderIsOwner: false,
          provenance: {
            kind: "inter_session",
            sourceTool: "subagent_announce",
            sourceSessionKey: entry.childSessionKey,
          },
        }),
        trackCompletion: true,
        assertCurrent: () => subagentRuns.runWithCompletionAuthority(current(), () => {}),
      }),
    );
  const input = expectDefined(await stage(), "original private input");
  await input.completeAsync!(
    buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
  );
  input.finish("interrupted");
  await input.settled?.();
  return async () => {
    const replay = expectDefined(await stage(), "restored private input");
    expect(replay.inputId).toBe(input.inputId);
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    await expect(replay.completeAsync!(outcome)).resolves.toEqual(outcome);
    replay.finish("interrupted");
    await replay.settled?.();
    expect(await readSessionPendingInput(scope, replay.inputId)).toBeUndefined();
    expect(await stage()).toMatchObject({ state: "consumed", completion: outcome });
  };
}
