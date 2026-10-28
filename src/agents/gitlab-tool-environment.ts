import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEffectiveGitLabToolIdentity,
  resolveManagedGitLabProfileDir,
} from "./gitlab-tool-identity-selection.js";

const AMBIENT_GITLAB_AUTH = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "CI_JOB_TOKEN",
  "GLAB_CONFIG_DIR",
  "GITLAB_HOST",
  "GL_HOST",
  "GITLAB_SUBFOLDER",
  "GLAB_API_HOST",
  "API_PROTOCOL",
  "GLAB_API_PROTOCOL",
  "GITLAB_API_HOST",
  "GITLAB_API_PROTOCOL",
  "GITLAB_URI",
  "GITLAB_CI",
  "GLAB_CI",
  "CI_SERVER_FQDN",
  "CI_SERVER_HOST",
  "CI_SERVER_URL",
] as const;
/** Every selected run must scrub ambient glab, GitLab, and Git author configuration. */
export function prepareGitLabToolEnvironment(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}) {
  const selected = resolveEffectiveGitLabToolIdentity(params);
  const scrub: Record<string, string> = {};
  if (selected) {
    for (const key of AMBIENT_GITLAB_AUTH) {
      scrub[key] = "";
    }
  }
  const localIdentityEnv: Record<string, string> = selected
    ? {
        GLAB_CONFIG_DIR: resolveManagedGitLabProfileDir({
          ...params,
          scope: selected.scope,
          profileId: selected.identity.profileId,
        }),
        GITLAB_HOST: new URL(selected.identity.issuer).host,
      }
    : {};
  return Object.freeze({
    credentialScrubEnv: Object.freeze(scrub),
    excludedStoreNames: Object.freeze(
      selected ? [`gitlab-oauth-${selected.identity.profileId.slice(4)}`] : [],
    ),
    localIdentityEnv: Object.freeze(localIdentityEnv),
    managedLocalIdentity: Boolean(selected),
    ...(selected ? { hostExecutionRequired: true as const } : {}),
  });
}
