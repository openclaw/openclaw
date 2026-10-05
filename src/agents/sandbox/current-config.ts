// Hot sandbox config mismatches stay live for normal sessions but fail closed for delegation
// and for a changed config that no longer passes sandbox security.
import { formatCliCommand } from "../../cli/command-format.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxDockerConfig, SandboxScope } from "./types.js";
import { validateSandboxCreateSecurity } from "./validate-sandbox-security.js";

function formatSandboxRecreateHint(params: {
  scope: SandboxScope;
  sessionKey: string;
  browser?: boolean;
}) {
  const command = `openclaw sandbox recreate${params.browser ? " --browser" : ""}`;
  if (params.scope === "session") {
    return formatCliCommand(`${command} --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`${command} --agent ${agentId}`);
  }
  return formatCliCommand(`${command} --all`);
}

export function handleHotSandboxConfigMismatch(params: {
  containerName: string;
  requireCurrentConfig?: boolean;
  mountsChanged?: boolean;
  browser?: boolean;
  scope: SandboxScope;
  sessionKey: string;
}) {
  const hint = formatSandboxRecreateHint(params);
  if (params.mountsChanged) {
    throw new Error(
      `Sandbox mounts changed for ${params.containerName}; the running container was preserved but cannot be reused with different filesystem sources or access modes. Recreate first: ${hint}`,
    );
  }
  if (params.requireCurrentConfig) {
    throw new Error(
      `Sandbox config changed for ${params.containerName}; restricted dispatch requires the current container config. Recreate first: ${hint}`,
    );
  }
  defaultRuntime.log(
    `Sandbox config changed for ${params.containerName} (recently used). Recreate to apply: ${hint}`,
  );
}

/**
 * A config change keeps a hot container's mounts, so a bind whose allowed root or dangerous
 * override was revoked would stay reachable. Reuse and replacement run the create-time check
 * first; refusal leaves the container and its data in place.
 */
export function assertChangedSandboxConfigAllowed(params: {
  containerName: string;
  cfg: SandboxDockerConfig;
  bindSourceRoots: string[];
  browser?: boolean;
  scope: SandboxScope;
  sessionKey: string;
}) {
  try {
    validateSandboxCreateSecurity(params);
  } catch (error) {
    throw new Error(
      `Sandbox config changed for ${params.containerName}; the existing container was preserved and will not be used because the current config fails sandbox security. ${formatErrorMessage(error)} To drop the bind instead, remove it from the config and recreate: ${formatSandboxRecreateHint(params)}`,
      { cause: error },
    );
  }
}
