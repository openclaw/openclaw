import type { McpAppRequesterIdentity } from "./agent-bundle-mcp-types.js";
import { captureAgentQuestionAnswerAuthority } from "./harness/host-private-capabilities.js";

/** Question admission owns the mapped profile; channel sender IDs cannot substitute for it. */
export function captureMcpFormRequester(sessionKey?: string): McpAppRequesterIdentity | undefined {
  const profileId = sessionKey
    ? captureAgentQuestionAnswerAuthority(sessionKey)?.requesterProfileId
    : undefined;
  return profileId ? { kind: "gateway-profile", profileId } : undefined;
}
