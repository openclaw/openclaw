import type {
  ExecutionEnvironmentPreparationV1,
  ExecutionEnvironmentProviderV1,
  PreparedExecutionEnvironment,
} from "openclaw/plugin-sdk/execution-environment";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { isBundledPluginEnabled } from "openclaw/plugin-sdk/plugin-config-runtime";
import { getShellConfig } from "openclaw/plugin-sdk/process-runtime";
import { readGitHubAgentIdentity } from "./config-api.js";
import { buildGitHubExecLaunchArgv } from "./exec-launch-api.js";
import { formatGitHubCoauthor } from "./git-attribution-api.js";
import { CLEARED_GITHUB_CREDENTIALS } from "./host-api.js";
import { prepareGitHubToolEnvironment } from "./tool-identity-api.js";

const sandboxLog = createSubsystemLogger("agent/sandbox");

const SANDBOX_PROFILE_PATH = "/openclaw/github";
function prepare(input: ExecutionEnvironmentPreparationV1): PreparedExecutionEnvironment {
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const { managedLocalIdentity, ...facts } = prepareGitHubToolEnvironment(input);
  const profileDir = managedLocalIdentity ? facts.localIdentityEnv.GH_CONFIG_DIR : undefined;
  const host = facts.localIdentityEnv.GH_HOST;
  return {
    ...facts,
    ...(profileDir
      ? {
          wrapLocalLaunch(argv: readonly string[]) {
            input.assertCurrent();
            input.signal?.throwIfAborted();
            return buildGitHubExecLaunchArgv([...argv], profileDir, { githubHost: host });
          },
        }
      : {}),
  };
}

export const githubExecutionEnvironment: ExecutionEnvironmentProviderV1 = {
  id: "github-repositories",
  formatGitCoauthor(input) {
    return isBundledPluginEnabled(input.config, "github-repositories")
      ? formatGitHubCoauthor(input)
      : undefined;
  },
  prepare,
  async prepareSandbox(input) {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    if (
      !isBundledPluginEnabled(input.config, "github-repositories") ||
      readGitHubAgentIdentity(input.config, input.agentId)?.allowInSandbox !== true
    ) {
      return undefined;
    }
    if (input.scope === "shared") {
      const message = `GitHub identity for agent "${input.agentId}" cannot enter a shared sandbox; use agent or session scope.`;
      sandboxLog.warn(message);
      throw new Error(message);
    }
    if (input.backend !== "docker" && input.backend !== "podman") {
      throw new Error("Sandbox GitHub identity requires the built-in Docker or Podman backend.");
    }
    const facts = prepareGitHubToolEnvironment(input);
    const profileDir = facts.localIdentityEnv.GH_CONFIG_DIR;
    if (!profileDir) {
      throw new Error("Sandbox GitHub identity profile is unavailable; reconnect GitHub Identity.");
    }
    const host = facts.localIdentityEnv.GH_HOST;
    const externalCommandShell = process.platform === "win32" ? getShellConfig() : undefined;
    return {
      credentialScrubEnv: facts.credentialScrubEnv,
      localIdentityEnv: { ...facts.localIdentityEnv, GH_CONFIG_DIR: SANDBOX_PROFILE_PATH },
      wrapLocalLaunch(argv: readonly string[]) {
        input.assertCurrent();
        input.signal?.throwIfAborted();
        return buildGitHubExecLaunchArgv([...argv], profileDir, {
          githubHost: host,
          externalCommandShell,
        });
      },
      readOnlyResourceMounts: [{ hostPath: profileDir, containerPath: SANDBOX_PROFILE_PATH }],
      inheritedEnvironmentNames: Object.keys(CLEARED_GITHUB_CREDENTIALS),
    };
  },
};
