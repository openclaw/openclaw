// An OpenClaw command started from the original install or an old runtime slot
// runs the slot that <state>/runtime/slots.json selects, through the launcher
// written next to it. Dependency-free: it runs before the CLI loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readProfileArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      return undefined;
    }
    if (arg === "--dev") {
      return "dev";
    }
    if (arg === "--profile") {
      return argv[index + 1];
    }
    if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length);
    }
  }
  return undefined;
}

/**
 * Mirrors resolveStateDir for the env and root options the CLI accepts before it
 * loads. A disagreement finds no pointer, so the command runs where it started.
 */
export function resolveRuntimeSlotsDir(env = process.env, argv = process.argv.slice(2)) {
  const home = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const profile = (readProfileArg(argv) ?? env.OPENCLAW_PROFILE)?.trim();
  const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
  const stateDir = override
    ? path.resolve(override.replace(/^~(?=$|[/\\])/u, home))
    : path.join(home, `.openclaw${suffix}`);
  return path.join(stateDir, "runtime");
}

const realpath = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * Resolves only when this root is the selected slot or unmanaged. Otherwise the
 * launcher replaces this process, or owns it until its child exits.
 */
export async function redirectToCurrentRuntimeSlot(packageRoot, { gatewayRun }) {
  if (process.platform === "win32") {
    return;
  }
  const own = realpath(packageRoot);
  const dir = resolveRuntimeSlotsDir();
  let pointer;
  try {
    pointer = JSON.parse(fs.readFileSync(path.join(dir, "slots.json"), "utf8"));
  } catch {
    return;
  }
  const managed = own === realpath(pointer.origin) || own.startsWith(`${realpath(dir)}${path.sep}`);
  if (!managed || own === realpath(pointer.current)) {
    return;
  }
  const { launchRuntime } = await import(pathToFileURL(path.join(dir, "launcher.mjs")).href);
  launchRuntime(dir, process.argv.slice(2), { start: gatewayRun });
  // Only a runtime without execve reaches here; its child decides the exit.
  await new Promise(() => {});
}
