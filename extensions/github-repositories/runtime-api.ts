import { controlUiGitHubHandlers } from "./src/control-ui-github.js";
import { repositoryProjectHandlers } from "./src/projects.js";
import { toolsGitHubHandlers } from "./src/tools-github.js";
import { usersGitHubHandlers } from "./src/users-github.js";
export { repositoryProjectHandlers };

export const repositoryHandlers = {
  ...toolsGitHubHandlers,
  ...controlUiGitHubHandlers,
  ...usersGitHubHandlers,
  ...repositoryProjectHandlers,
};

export { controlUiGitHubHandlers };

/** Public bundled-plugin facts and factories used by host integration fixtures. */
export { currentGitHubPublicationConfig } from "./publication-availability-api.js";
export { createGitHubPublicationProvider } from "./publication-provider-api.js";
export { prepareGitHubPublicationTarget } from "./publication-target-api.js";
export { readGitHubConfig } from "./config-api.js";
export { readRepositoryServices } from "./account-runtime-api.js";
export { writeManagedGitHubProfileFiles } from "./tool-profile-files-api.js";
export { resolveGitHubHost, resolveGitHubApiBaseUrl } from "./host-runtime-api.js";
export { managedGitHubIdentityEnvironment } from "./tool-identity-env-api.js";
export { parseProjectGitUrl } from "./project-url-api.js";
export { resolveConfiguredGitHubHost, resolveConfiguredGitHubApiBaseUrl } from "./host-api.js";
export { gitHubPublicApi, githubApiToken } from "./public-api.js";
export { prepareCurrentGitHubPublicationOptionsIdentity } from "./publication-availability-api.js";
export { isGitHubPublicationSuperseded } from "./publication-relevance-api.js";
export { GitHubIdentityError } from "./read-identity-api.js";
export {
  createControlUiSessionPrRead,
  prepareControlUiSessionPrServiceTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read-api.js";
export { createGitHubIdentityStatusTool } from "./identity-status-tool-api.js";
export { createGitHubPublishTool, githubPublishToolDefinition } from "./publish-tool-api.js";
export { parseGitHubRemoteUrl } from "./remote-api.js";
export { resolveManagedGitHubProfileDir } from "./tool-identity-api.js";
export { createGitHubRepositorySource } from "./repository-source-api.js";
export { clearGitHubCredentialVerificationCache } from "./oauth-api.js";

export { startGitHubSessionPresentation } from "./session-presentation-service-api.js";
export type { ControlUiSessionPrRead } from "./control-ui-session-pr-read-api.js";
export {
  requestCurrentGitHubOAuthRefresh,
  requestCurrentPersonalGitHubRefresh,
} from "./account-runtime-api.js";
