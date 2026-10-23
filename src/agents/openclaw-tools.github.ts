import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createGitHubIdentityStatusTool } from "./tools/github-identity-status-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";

export function resolveOpenClawGitHubTools(options: OpenClawToolsOptions | undefined): {
  identitySettingsAvailable: boolean;
  tools: AnyAgentTool[];
} {
  const identitySettingsAvailable =
    options?.clientCaps?.includes(GATEWAY_CLIENT_CAPS.UI_AGENT_GITHUB_SETTINGS) === true;
  return {
    identitySettingsAvailable,
    tools: [
      ...(options?.githubPublicationAvailable !== undefined
        ? [
            createGitHubIdentityStatusTool({
              githubIdentitySettingsAvailable: identitySettingsAvailable,
            }),
          ]
        : []),
      ...(options?.githubPublicationAvailable === true ? [createGitHubPublishTool()] : []),
    ],
  };
}
