import path from "node:path";
import { prependShellPath } from "../infra/login-shell-path-carrier.js";
import { findPathKey, removePathPrepend } from "../infra/path-prepend.js";
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
  let commandWithPathPrepend = params.execCommand ?? params.command;
  const pathPrepend = params.pathPrepend;
  if (process.platform !== "win32" && pathPrepend && pathPrepend.length > 0) {
    // Reapply prefixes after shell startup without duplicating them in the base PATH.
    const pathKey = findPathKey(params.env);
    const currentPath = params.env[pathKey];
    if (currentPath) {
      const newPath = removePathPrepend(currentPath, pathPrepend);
      if (newPath !== undefined) {
        params.env[pathKey] = newPath;
      }
    }
    commandWithPathPrepend = prependShellPath(
      commandWithPathPrepend,
      params.env,
      pathPrepend.join(path.delimiter),
    );
  }
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
      ? buildGitHubExecLaunchArgv(shellArgv, params.githubProfileDir, {
          githubHost: params.env.GH_HOST,
        })
      : shellArgv,
    env: params.env,
    cwd: params.workdir,
    stdinMode: params.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
  };
}
