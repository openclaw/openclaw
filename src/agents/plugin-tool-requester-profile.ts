import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { readTransferredRequesterProfile } from "../auto-reply/requester-profile.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { assertAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

/** The original admitted requester is not a model-selected participant or a transport sender. */
export function capturePluginToolRequesterProfile(target: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): OpenClawPluginToolContext["requesterProfile"] {
  const caller = getGatewayToolCallerIdentity();
  const authority = caller?.operatorAuthority;
  const instance = caller?.operationalRunInstance;
  if (
    !caller ||
    !authority ||
    !instance ||
    !target.runId ||
    caller.turnSourceChannel !== "webchat" ||
    caller.agentId !== target.agentId ||
    caller.sessionKey !== target.sessionKey ||
    !target.sessionId ||
    caller.sessionId !== target.sessionId ||
    instance.runId !== target.runId ||
    authority.profileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  let participant;
  try {
    participant = caller.personalToolParticipants?.resolve();
  } catch {
    // Unproven or ambiguous construction exposes no personal capability; retained guards still throw.
    return undefined;
  }
  const profile = participant && readTransferredRequesterProfile(participant);
  if (
    !profile ||
    profile.id !== authority.profileId ||
    participant?.operatorAuthority !== authority
  ) {
    return undefined;
  }
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  if (!assertCallerCurrent) {
    return undefined;
  }
  const id = authority.profileId;
  const assertCurrent = () => {
    assertCallerCurrent();
    participant.assertCurrent();
    const current = getGatewayToolCallerIdentity();
    if (
      (current &&
        (current.operationalRunInstance !== instance ||
          current.agentId !== caller.agentId ||
          current.sessionKey !== caller.sessionKey)) ||
      (current && current.sessionId !== caller.sessionId) ||
      readTransferredRequesterProfile(participant)?.id !== id
    ) {
      throw new Error("Plugin requester profile is no longer current; start a new turn.");
    }
  };
  assertCurrent();
  return Object.freeze({ id, assertCurrent });
}
