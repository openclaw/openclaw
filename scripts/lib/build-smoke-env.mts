import path from "node:path";

/** Keep built runtime imports and their children away from operator state. */
export function createBuildSmokeEnv(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const stateDir = path.join(home, ".openclaw");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_RUNTIME_DIR: path.join(home, ".run"),
  };
}
