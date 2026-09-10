import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RequesterMcpConnectDelivery,
  SessionMcpRequesterScope,
} from "./agent-bundle-mcp-types.js";

/** Keeps personal setup links outside model results and shared conversation history. */
export function createRequesterMcpConnectDelivery(params: {
  cfg?: OpenClawConfig;
  requesterScope?: SessionMcpRequesterScope;
  assertActive?: () => void;
}): RequesterMcpConnectDelivery | undefined {
  const { cfg, assertActive } = params;
  const channel = params.requesterScope?.messageChannel?.trim();
  const accountId = params.requesterScope?.agentAccountId?.trim();
  const senderId = params.requesterScope?.requesterSenderId.trim();
  if (!cfg || !channel || !accountId || !senderId || !assertActive) {
    return undefined;
  }
  return {
    assertActive,
    async send(request) {
      const assertCurrent = () => {
        assertActive();
        request.assertActive();
      };
      assertCurrent();
      const { sendRequesterPrivateMessage } =
        await import("../infra/outbound/requester-private.js");
      assertCurrent();
      return await sendRequesterPrivateMessage({
        cfg,
        channel,
        accountId,
        senderId,
        text:
          `Connect your ${request.serverName} account:\n${request.authorizationUrl}\n\n` +
          "Keep this sign-in link private. After authorization completes, return to your conversation and send another message to use the connection.",
        assertActive: assertCurrent,
      });
    },
  };
}
