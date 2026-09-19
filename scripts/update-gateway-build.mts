// Source-update lifecycle adapter. Build ownership and output selection remain
// with the same owners used by standalone builds and declaration consumers.
import fs from "node:fs";
import path from "node:path";
import { runBuildAllSteps } from "./build-all.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { listTsdownOutputRoots } from "./tsdown-build.mts";

const log = (message: string) => console.error(`[update-gateway] ${message}`);

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
  return await withDistArtifactOwnership(root, async () => {
    const roots = listTsdownOutputRoots();
    // Validate parents as well as final components before any service effects.
    // This is the same no-symlink contract as the build cleanup owner.
    for (const output of roots) {
      let current = root;
      for (const component of output.split("/")) {
        current = path.join(current, component);
        assertRealOutputRoot(current);
      }
    }
    log(`stopping gateway before replacing hashed build chunks: ${stopCommand}`);
    const stopped = await lifecycle(stopCommand);
    if (stopped !== 0) {
      return stopped;
    }

    let backup: string | undefined;
    let buildStarted = false;
    let failed: unknown;
    let exitCode = 1;
    try {
      backup = fs.mkdtempSync(path.join(root, ".update-build-backup."));
      for (const output of roots) {
        const source = path.join(root, output);
        if (fs.existsSync(source)) {
          const destination = path.join(backup, output);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          // Copy rather than move: the build deliberately preserves UI assets,
          // signed app bundles and some declarations inside its output roots.
          fs.cpSync(source, destination, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            preserveTimestamps: true,
          });
        }
      }
      buildStarted = true;
      exitCode = (await build()).exitCode;
    } catch (error) {
      failed = error;
    }

    if (exitCode !== 0 || failed) {
      if (hasUnjoinedWork(failed)) {
        throw new Error(`Build writers have not settled; previous output retained at ${backup}`, {
          cause: failed,
        });
      }
      if (buildStarted && backup) {
        log("restoring previous build output");
        try {
          // Validate the whole replacement set before restoring any root.
          for (const output of roots) {
            // Build children have joined; do not follow a replaced root/parent.
            let current = root;
            for (const component of output.split("/")) {
              current = path.join(current, component);
              assertRealOutputRoot(current);
            }
          }
          for (const output of roots) {
            const destination = path.join(root, output);
            fs.rmSync(destination, { recursive: true, force: true });
            const previous = path.join(backup, output);
            if (fs.existsSync(previous)) {
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.renameSync(previous, destination);
            }
          }
        } catch (error) {
          throw new Error(`Previous output could not be fully restored; retained ${backup}`, {
            cause: error,
          });
        }
      }
      log("restarting gateway on previous build after update failure");
      const restarted = await lifecycle(restartCommand);
      if (restarted !== 0) {
        throw new Error(
          `Previous build restored, but restart failed (${restarted}); backup: ${backup}`,
        );
      }
      if (backup) {
        fs.rmSync(backup, { recursive: true, force: true });
      }
      if (failed) {
        throw failed instanceof Error ? failed : new Error("Build failed", { cause: failed });
      }
      return exitCode;
    }

    log(`restarting gateway: ${restartCommand}`);
    const restarted = await lifecycle(restartCommand);
    if (restarted !== 0) {
      // A failed restart can still leave a new Gateway running. Do not replace
      // its chunks underneath it; keep the previous output for operator recovery.
      throw new Error(
        `New build restart failed (${restarted}); previous output retained at ${backup}`,
      );
    }
    fs.rmSync(backup!, { recursive: true, force: true });
    return 0;
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [stopCommand, restartCommand, pnpmDirectory] = process.argv.slice(2);
  if (!stopCommand?.trim() || !restartCommand?.trim() || !pnpmDirectory) {
    throw new Error("Source update build requires nonblank stop and restart commands");
  }
  process.exitCode = await runUpdateGatewayBuild(stopCommand, restartCommand, pnpmDirectory);
}
