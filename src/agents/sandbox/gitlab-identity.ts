import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentConfig } from "../agent-scope-config.js";
import { GITLAB_EXEC_HOST_OVERRIDE_SCRUB } from "../gitlab-exec-ambient.js";
import { prepareGitLabToolEnvironment } from "../gitlab-tool-identity.js";
import { SANDBOX_GITLAB_CONFIG_DIR } from "./constants.js";
import type { SandboxScope } from "./types.js";

/** Only an explicit agent opt-in may project one selected profile into a private sandbox. */
export async function prepareGitLabSandboxIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: SandboxScope;
  env?: NodeJS.ProcessEnv;
}) {
  if (resolveAgentConfig(params.config, params.agentId)?.tools?.gitlab?.allowInSandbox !== true) {
    return undefined;
  }
  if (params.scope === "shared") {
    throw new Error(
      `GitLab identity for agent "${params.agentId}" cannot enter a shared sandbox; use agent or session scope.`,
    );
  }
  const prepared = prepareGitLabToolEnvironment(params);
  const identity = Object.freeze({
    ...prepared,
    credentialScrubEnv: Object.freeze({
      ...prepared.credentialScrubEnv,
      ...GITLAB_EXEC_HOST_OVERRIDE_SCRUB,
    }),
  });
  const profileDir = identity.localIdentityEnv.GLAB_CONFIG_DIR;
  const stat = profileDir ? await fs.lstat(profileDir).catch(() => undefined) : undefined;
  if (!profileDir || !stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Sandbox GitLab identity profile is unavailable; reconnect GitLab Identity.");
  }
  return {
    identity,
    profileDir,
    mount: {
      hostPath: await fs.realpath(profileDir),
      containerPath: SANDBOX_GITLAB_CONFIG_DIR,
    },
  };
}
