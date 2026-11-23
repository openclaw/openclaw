import type { GatewayUiCommandTarget } from "../gateway/ui-command-target.types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import {
  assertSessionControllerOperation,
  getOperationBackendRunIds,
  readSessionControllerOperationState,
} from "../sessions/session-controller.state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import {
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import type { WebchatMcpRequester } from "./agent-bundle-mcp-webchat-requester.types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** Host run facts, never model-supplied profile labels or shared-session attribution. */
export type WebchatMcpRequesterContext = {
  sessionId: string;
  sessionKey?: string;
  runId: string;
  senderId?: string | null;
  mcpRequesterProfileId?: string;
  messageChannel?: string | null;
  messageProvider?: string | null;
  admittedRunContext?: AdmittedRunContext;
  replyOperation?: ReplyOperation;
  toolAuthorityFingerprint?: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  inputProvenance?: InputProvenance;
  spawnedBy?: string | null;
  trigger?: string;
  controlOperation?: unknown;
  scheduledToolPolicy?: unknown;
  abortSignal?: AbortSignal;
};

/** Harnesses consume the host-owned capture without receiving private admission state. */
export function readWebchatMcpRequester(run: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
}): WebchatMcpRequester | undefined {
  const caller = getGatewayToolCallerIdentity();
  const requester = caller?.webchatMcpRequester;
  return requester &&
    requester.sessionId === run.sessionId &&
    requester.sessionKey === run.sessionKey &&
    (run.runId === undefined || run.runId === requester.runId) &&
    caller.operationalRunInstance?.runId === requester.runId
    ? requester
    : undefined;
}

/** Capture only server-verified user turns. A browser must also own the exact live input. */
export function captureRunMcpRequester(
  run: WebchatMcpRequesterContext,
): WebchatMcpRequester | undefined {
  if (run.gatewayUiCommandTarget) {
    return run.mcpRequesterProfileId === run.gatewayUiCommandTarget.profileId
      ? captureWebchatMcpRequester(run)
      : undefined;
  }
  const { mcpRequesterProfileId: profileId, admittedRunContext, sessionKey } = run;
  if (
    !profileId ||
    !sessionKey ||
    run.spawnedBy ||
    run.scheduledToolPolicy ||
    run.controlOperation ||
    run.trigger === "memory" ||
    (run.inputProvenance && run.inputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const assertActive = admittedRunContext
    ? resolveAdmittedRunActiveAssertion(admittedRunContext, run.abortSignal)
    : undefined;
  const participants = run.replyOperation?.personalToolParticipants;
  return Object.freeze({
    sessionId: run.sessionId,
    sessionKey,
    runId: run.runId,
    requesterSenderId: profileId,
    assertCurrent: () => {
      const authority = readAdmittedRunOperatorAuthority(admittedRunContext);
      if (
        !assertActive ||
        authority?.profileId !== profileId ||
        (participants && participants.resolve()?.profileId !== profileId)
      ) {
        throw new Error("Personal MCP requires the current authenticated requester.");
      }
      assertActive();
      authority.assertCurrent();
    },
  });
}

/** Profiles use the same durable principal as MCP Apps, not the transport account. */
export function profileMcpRequesterScope(requester: WebchatMcpRequester) {
  return {
    requesterSenderId: requester.requesterSenderId,
    agentAccountId: undefined,
    messageChannel: INTERNAL_MESSAGE_CHANNEL,
  };
}

/** Use the existing live personal-tool owner when Webchat has no transport SenderId. */
export function captureWebchatMcpRequester(
  run: WebchatMcpRequesterContext,
): WebchatMcpRequester | undefined {
  const admitted = run.admittedRunContext;
  const operation = run.replyOperation;
  const target = run.gatewayUiCommandTarget;
  const turnKind = readSessionControllerOperationState(operation)?.turnKind;
  if (
    run.senderId?.trim() ||
    (run.messageChannel ?? run.messageProvider) !== "webchat" ||
    !admitted ||
    admitted.admissionSource ||
    admitted.operationalRunInstance.runId !== run.runId ||
    !operation ||
    (turnKind !== "direct" && turnKind !== "visible") ||
    !getOperationBackendRunIds(operation)?.has(run.runId) ||
    operation.sessionId !== run.sessionId ||
    operation.key !== run.sessionKey ||
    !run.toolAuthorityFingerprint ||
    operation.toolAuthorityFingerprint !== run.toolAuthorityFingerprint ||
    !target?.connId ||
    !target.profileId ||
    (run.inputProvenance && run.inputProvenance.kind !== "external_user") ||
    run.spawnedBy ||
    run.trigger === "memory" ||
    run.controlOperation ||
    run.scheduledToolPolicy
  ) {
    return undefined;
  }
  const authority = readAdmittedRunOperatorAuthority(admitted);
  const participants = operation.personalToolParticipants;
  if (!authority || authority.profileId !== target.profileId || !participants) {
    return undefined;
  }
  const source = authority.source ?? authority;
  const assertRunCurrent = resolveAdmittedRunActiveAssertion(admitted, run.abortSignal);
  if (!assertRunCurrent) {
    return undefined;
  }
  const assertCurrent = () => {
    assertRunCurrent();
    assertSessionControllerOperation(operation);
    authority.assertCurrent();
    if (
      !getOperationBackendRunIds(operation)?.has(run.runId) ||
      operation.toolAuthorityFingerprint !== run.toolAuthorityFingerprint ||
      operation.personalToolParticipants !== participants
    ) {
      throw new Error("Requester MCP turn authority changed; ask again in a new turn.");
    }
    // Do not silently choose the turn owner after another person has steered it.
    const person = participants.resolve();
    if (
      !person ||
      person.profileId !== target.profileId ||
      (person.operatorAuthority.source ?? person.operatorAuthority) !== source ||
      person.gatewayUiCommandTarget?.connId !== target.connId ||
      person.gatewayUiCommandTarget.profileId !== target.profileId
    ) {
      throw new Error("Requester MCP has no matching live Webchat participant.");
    }
    person.assertCurrent();
  };
  return Object.freeze({
    sessionId: run.sessionId,
    sessionKey: operation.key,
    runId: run.runId,
    requesterSenderId: target.profileId,
    assertCurrent,
  });
}
