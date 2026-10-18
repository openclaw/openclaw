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
  const commandWithPathPrepend = wrapPosixCommandWithPathPrepend(
    params.execCommand ?? params.command,
    params.env,
    params.pathPrepend,
  );
  const commandWithShellSnapshot = await maybeWrapCommandWithShellSnapshot({
    // A bound execution plan must not load aliases/functions or replace its PATH.
    enabled: params.execCommand === undefined,
    command: commandWithPathPrepend,
    shell,
    shellArgs,
    cwd: params.workdir,
    env: params.env,
  });
  const shellArgv = [shell, ...shellArgs, commandWithShellSnapshot];
  return {
    mode: params.usePty ? ("pty" as const) : ("child" as const),
    argv: params.githubProfileDir
      ? buildGitHubExecLaunchArgv(shellArgv, params.githubProfileDir)
      : shellArgv,
    env: params.env,
    cwd: params.workdir,
    stdinMode: params.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
  };
}
