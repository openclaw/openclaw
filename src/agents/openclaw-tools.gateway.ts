import { hasMultipleSessionSharingIdentities } from "../state/user-profile-list.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createOpenClawDelegateToolsForRun } from "./tools/openclaw-delegate-tool.js";
import { createPersonalInstructionsTool } from "./tools/personal-instructions-tool.js";
import { createPluginsTool } from "./tools/plugins-tool.js";
import { createPresenceTool } from "./tools/presence-tool.js";

/** Gateway-owned operations are not standalone embedded-host capabilities. */
export function createHostedGatewayTools(
  embedded: boolean,
  sessionAgentId: string,
  options?: OpenClawToolsOptions,
): AnyAgentTool[] {
  if (embedded) {
    return [];
  }
  return [
    createPresenceTool({ runId: options?.runId }),
    createGatewayTool({
      allowConfigReads: options?.gatewayConfigReadAllowed === true,
      senderIsOwner: options?.senderIsOwner,
      requesterSenderId: options?.requesterSenderId,
    }),
    createPluginsTool(),
    ...createOpenClawDelegateToolsForRun({ ...options, sessionAgentId }),
    ...(hasMultipleSessionSharingIdentities()
      ? [createPersonalInstructionsTool(sessionAgentId)]
      : []),
  ];
}
