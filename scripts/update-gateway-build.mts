// Source-update lifecycle adapter. Both entry paths share the output transaction.
import fs from "node:fs";
import path from "node:path";
import { runBuildAllSteps } from "./build-all.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { runSourceUpdateBuild } from "./lib/source-update-build.mts";

export async function runUpdateGatewayBuild(
  stopCommand: string,
  restartCommand: string,
  pnpmDirectory: string,
): Promise<number> {
  const root = fs.realpathSync(process.cwd());
  const lifecycle = (command: string) =>
    runManagedCommand({
      bin: "bash",
      args: ["-c", command],
      cwd: root,
      stdio: "inherit",
      // Service commands can intentionally leave a daemon running. Only build
      // writers must join their whole process tree before output restoration.
    });
  const build = () =>
    runBuildAllSteps("full", {
      env: {
        ...process.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        PATH: `${pnpmDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: path.join(pnpmDirectory, "pnpm"),
        NPM_CONFIG_WORKSPACE_DIR: root,
        npm_config_workspace_dir: root,
        PNPM_CONFIG_LOCKFILE_DIR: root,
        pnpm_config_lockfile_dir: root,
      },
    });
  return await runSourceUpdateBuild({
    root,
    build,
    lifecycle: {
      stop: () => lifecycle(stopCommand),
      restart: () => lifecycle(restartCommand),
      successRestartOwner: "adapter",
    },
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [stopCommand, restartCommand, pnpmDirectory] = process.argv.slice(2);
  if (!stopCommand?.trim() || !restartCommand?.trim() || !pnpmDirectory) {
    throw new Error("Source update build requires nonblank stop and restart commands");
  }
  process.exitCode = await runUpdateGatewayBuild(stopCommand, restartCommand, pnpmDirectory);
}
