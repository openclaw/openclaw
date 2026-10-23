import { omitGatewayCredentialEnv } from "../infra/host-env-security.js";
import { wrapPosixCommandWithPathPrepend } from "./bash-tools.exec-path-prepend.js";
import { buildGitHubExecLaunchArgv } from "./github-exec-launch.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { getShellConfig } from "./shell-utils.js";

export async function prepareHostExecSpawn(params: {
  command: string;
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  pathPrepend?: string[];
  githubProfileDir?: string;
  usePty: boolean;
}) {
  const { shell, args: shellArgs } = getShellConfig();
  // The env may predate an approval wait; credential names published since then stay out.
  const env = omitGatewayCredentialEnv(params.env);
  const commandWithPathPrepend = wrapPosixCommandWithPathPrepend(
    params.execCommand ?? params.command,
    env,
    params.pathPrepend,
  );
  const commandWithShellSnapshot = await maybeWrapCommandWithShellSnapshot({
    // A bound execution plan must not load aliases/functions or replace its PATH.
    enabled: params.execCommand === undefined,
    command: commandWithPathPrepend,
    shell,
    shellArgs,
    cwd: params.workdir,
    env,
  });
  const shellArgv = [shell, ...shellArgs, commandWithShellSnapshot];
  return {
    mode: params.usePty ? ("pty" as const) : ("child" as const),
    argv: params.githubProfileDir
      ? buildGitHubExecLaunchArgv(shellArgv, params.githubProfileDir)
      : shellArgv,
    env,
    cwd: params.workdir,
    stdinMode: params.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
  };
}

/** Final launch env; host launches re-apply the credential names published right now. */
export function resolveExecLaunchEnv(
  env: NodeJS.ProcessEnv | undefined,
  sandboxed: boolean,
  grantEnv?: Record<string, string>,
): NodeJS.ProcessEnv | undefined {
  const launchEnv = env && !sandboxed ? omitGatewayCredentialEnv(env) : env;
  return grantEnv ? { ...launchEnv, ...grantEnv } : launchEnv;
}
