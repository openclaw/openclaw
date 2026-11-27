import type { GatewayUiCommandTarget } from "../gateway/ui-command-target.types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { ReplyTurnParticipants } from "../sessions/session-controller.contracts.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import type { WebchatMcpRequester } from "./agent-bundle-mcp-webchat-requester.types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** Consume the attempt owner's capture, not caller-supplied transcript or run IDs. */
export function readWebchatMcpRequester(run: {
  sessionKey?: string;
}): WebchatMcpRequester | undefined {
  const caller = getGatewayToolCallerIdentity();
  return caller?.sessionKey === run.sessionKey ? caller?.webchatMcpRequester : undefined;
}

/** Only the host's prepared tool-authority scope can supply these admission facts. */
export function captureRunMcpRequester(params: {
  sessionId: string;
  mcpRequesterProfileId?: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertActive: () => void;
  participants?: ReplyTurnParticipants;
  directBrowserTurn: boolean;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  senderId?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  inputProvenance?: InputProvenance;
  spawnedBy?: string | null;
  trigger?: string;
  controlOperation?: unknown;
  scheduledToolPolicy?: unknown;
}): WebchatMcpRequester | undefined {
  const { operatorAuthority, mcpRequesterProfileId: profileId, participants } = params;
  if (
    !profileId ||
    params.spawnedBy ||
    params.trigger === "memory" ||
    params.controlOperation ||
    params.scheduledToolPolicy ||
    (params.inputProvenance && params.inputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const browser = params.gatewayUiCommandTarget;
  if (
    browser &&
    (!params.directBrowserTurn ||
      !participants ||
      !browser.connId ||
      browser.profileId !== profileId ||
      params.senderId?.trim() ||
      (params.messageChannel ?? params.messageProvider) !== "webchat")
  ) {
    return undefined;
  }
  return Object.freeze({
    sessionId: params.sessionId,
    requesterSenderId: profileId,
    assertCurrent: () => {
      // Reuse the host's attempt fence for Stop and ownership, never mint a second one.
      params.assertActive();
      if (operatorAuthority?.profileId !== profileId) {
        // A verified-profile route must never fall back to the backend sender.
        throw new Error("Personal MCP requires the current authenticated requester.");
      }
      const person = participants?.resolve();
      if (
        (participants && person?.profileId !== profileId) ||
        (browser &&
          (!person ||
            (person.operatorAuthority.source ?? person.operatorAuthority) !==
              (operatorAuthority.source ?? operatorAuthority) ||
            person.gatewayUiCommandTarget?.connId !== browser.connId ||
            person.gatewayUiCommandTarget.profileId !== profileId))
      ) {
        throw new Error("Personal MCP requires the current authenticated requester.");
      }
    },
  });
}

/** Profiles use the same durable principal as MCP Apps, not the transport account. */
export function profileMcpRequesterScope(requester: WebchatMcpRequester) {
  return {
    sessionId: requester.sessionId,
    requesterSenderId: requester.requesterSenderId,
    agentAccountId: undefined,
    messageChannel: INTERNAL_MESSAGE_CHANNEL,
  };
}
