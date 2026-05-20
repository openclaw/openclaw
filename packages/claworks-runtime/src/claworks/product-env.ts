import os from "node:os";
import path from "node:path";

/** Default ClaWorks gateway port (OpenClaw default is 18789). */
export const CLAWORKS_DEFAULT_GATEWAY_PORT = 18_800;

export function isClaworksProduct(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWORKS_PRODUCT === "1";
}

/**
 * Isolate ClaWorks from a co-installed OpenClaw:
 * - state/config under ~/.claworks (not ~/.openclaw)
 * - default gateway port 18800
 * Call before config path resolution (entry + claworks.mjs wrapper).
 */
export function applyClaworksProductEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isClaworksProduct(env)) {
    return;
  }
  const home = os.homedir();
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".claworks");
  env.CLAWORKS_PRODUCT = "1";
  env.OPENCLAW_STATE_DIR ??= stateDir;
  env.OPENCLAW_CONFIG_PATH ??= path.join(stateDir, "claworks.json");
  env.CLAWORKS_GATEWAY_PORT ??= String(CLAWORKS_DEFAULT_GATEWAY_PORT);
}

/** Detect `claworks` CLI invocation and enable product mode. */
export function detectAndApplyClaworksCli(env: NodeJS.ProcessEnv = process.env): void {
  const argv1 = env._CLAWORKS_ARGV1 ?? process.argv[1] ?? "";
  const base = path.basename(argv1);
  if (base === "claworks" || base === "claworks.mjs" || base === "claworks.js") {
    env.CLAWORKS_PRODUCT = "1";
  }
  applyClaworksProductEnv(env);
}
