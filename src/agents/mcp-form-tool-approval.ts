import type { McpAppRequesterIdentity } from "./agent-bundle-mcp-types.js";
import { captureAgentQuestionAnswerAuthority } from "./harness/host-private-capabilities.js";
import type { McpAppFormOrigin, McpAppPrepareToolCall } from "./mcp-ui-resource.js";

/** Question admission owns the mapped profile; channel sender IDs cannot substitute for it. */
export function captureMcpFormRequester(sessionKey?: string): McpAppRequesterIdentity | undefined {
  const profileId = sessionKey
    ? captureAgentQuestionAnswerAuthority(sessionKey)?.requesterProfileId
    : undefined;
  return profileId ? { kind: "gateway-profile", profileId } : undefined;
}

/** Model-run forms retain their allowlist, then borrow current App approval for each preview. */
export function createMcpFormToolPreparer(
  origin: Pick<
    McpAppFormOrigin,
    "runtime" | "serverName" | "agentId" | "requesterId" | "assertCurrent"
  >,
  getAllowedTools: () => ReadonlySet<string> | undefined,
): McpAppPrepareToolCall {
  return async (action) => {
    const assertCurrent = () => {
      origin.assertCurrent();
      action.assertCurrent();
      if (!getAllowedTools()?.has(action.toolName)) {
        throw new Error("MCP form preview tool is not granted by the active run");
      }
    };
    assertCurrent();
    const { prepareModelCreatedAppToolCall } = await import("../gateway/mcp-app-operations.js");
    return await prepareModelCreatedAppToolCall(
      {
        runtime: origin.runtime,
        view: {
          serverName: origin.serverName,
          sessionId: origin.runtime.sessionId,
          agentId: origin.agentId,
          requesterId: origin.requesterId,
          allowedAppToolNames: getAllowedTools(),
        },
      },
      { ...action, assertCurrent },
    );
  };
}
