import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";
import type { PreparedGitHubToolEnvironment } from "./github-tool-identity.types.js";
import { GITLAB_EXEC_HOST_OVERRIDE_SCRUB } from "./gitlab-exec-ambient.js";
import { prepareGitLabToolEnvironment } from "./gitlab-tool-identity.js";

export type PreparedExecIdentityEnvironment = PreparedGitHubToolEnvironment &
  Readonly<{
    managedGitLabIdentity?: boolean;
  }>;

/** Selected GitLab CLI credentials belong only to this host or an opted-in private sandbox. */
export function assertManagedGitLabExecHost(params: {
  selected: boolean;
  host: "gateway" | "sandbox" | "node";
  sandboxProfileDir?: string;
}): void {
  if (!params.selected) {
    return;
  }
  if (params.host === "node") {
    throw new Error("Managed GitLab Identity requires local execution.");
  }
  if (params.host === "sandbox" && !params.sandboxProfileDir) {
    throw new Error(
      "Managed GitLab Identity requires an isolated sandbox with GitLab Identity enabled.",
    );
  }
}

/** Combine non-secret provider selection without changing native GitHub semantics. */
export function prepareExecIdentityEnvironment(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  preparedGitHub?: PreparedGitHubToolEnvironment;
}): PreparedExecIdentityEnvironment {
  const github = params.preparedGitHub ?? prepareGitHubToolEnvironment(params);
  const gitlab = prepareGitLabToolEnvironment(params);
  return Object.freeze({
    ...github,
    credentialScrubEnv: Object.freeze({
      ...github.credentialScrubEnv,
      ...gitlab.credentialScrubEnv,
      ...(gitlab.managedLocalIdentity ? GITLAB_EXEC_HOST_OVERRIDE_SCRUB : {}),
    }),
    localIdentityEnv: Object.freeze({
      ...github.localIdentityEnv,
      ...gitlab.localIdentityEnv,
    }),
    excludedStoreNames: Object.freeze([...github.excludedStoreNames, ...gitlab.excludedStoreNames]),
    managedGitLabIdentity: gitlab.managedLocalIdentity,
    ...(github.hostExecutionRequired || gitlab.hostExecutionRequired
      ? { hostExecutionRequired: true as const }
      : {}),
  });
}
