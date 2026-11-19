import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readGitHubPublicationConfiguration } from "./github-tool-identity-config.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { createGitHubIdentityStatusTool } from "./tools/github-identity-status-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";
import { createSessionProjectTool } from "./tools/session-project-tool.js";

/** Tools that publish this conversation's workspace or move it into a project. */
export function createSessionWorkspaceTools(
  options: OpenClawToolsOptions | undefined,
  params: { agentId: string; availabilityConfig?: OpenClawConfig; sessionProjectAllowed: boolean },
) {
  const github = options?.githubPublicationAvailable !== undefined;
  return [
    github ? createGitHubIdentityStatusTool(options) : null,
    github
      ? createGitHubPublishTool({
          ...options,
          publicationAvailable: options.githubPublicationAvailable,
          observationOnly:
            options.githubPublicationConfigurationAware === true &&
            readGitHubPublicationConfiguration({
              config: params.availabilityConfig ?? {},
              agentId: params.agentId,
            }) === "unconfigured",
          preview: options.githubPublicationPreview,
        })
      : null,
    params.sessionProjectAllowed ? createSessionProjectTool(options ?? {}) : null,
  ];
}
