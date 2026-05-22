import os from "node:os";
import path from "node:path";
import type { ClaworksRobotConfig } from "./config-types.js";

/** Default ClaWorks gateway port (OpenClaw default is 18789). */
export const CLAWORKS_DEFAULT_GATEWAY_PORT = 18_800;

export function isClaworksProduct(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWORKS_PRODUCT === "1";
}

/**
 * 生产模式：显式 config.production_mode 优先；未设置时读 CLAWORKS_PRODUCTION=1。
 */
export function isClaworksProductionMode(
  config: Pick<ClaworksRobotConfig, "production_mode">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.production_mode === true) {
    return true;
  }
  if (config.production_mode === false) {
    return false;
  }
  return env.CLAWORKS_PRODUCTION === "1";
}

/**
 * 判断环境变量是否指向 ClaWorks 专属路径
 * (.claworks 目录或 claworks.json 配置路径)
 */
export function looksLikeClaworksStateEnv(env: Partial<NodeJS.ProcessEnv>): boolean {
  const stateDir = env.OPENCLAW_STATE_DIR ?? "";
  if (
    stateDir &&
    (stateDir.endsWith("/.claworks") ||
      stateDir.endsWith("\\.claworks") ||
      stateDir === ".claworks")
  ) {
    return true;
  }
  const configPath = env.OPENCLAW_CONFIG_PATH ?? "";
  if (configPath && configPath.endsWith("claworks.json")) {
    return true;
  }
  return false;
}

/**
 * 当使用 openclaw 入口文件但 state 目录指向 ClaWorks 时，发出一次性警告。
 */
let _misEntryWarned = false;
export function warnIfOpenClawEntryWithClaworksState(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): void {
  if (env._CLAWORKS_MISENTRY_WARNED === "1") {
    return;
  }
  const argv1 = env._CLAWORKS_ARGV1 ?? "";
  const base = path.basename(argv1);
  const isOpenClawEntry = base === "openclaw" || base === "openclaw.mjs" || base === "openclaw.js";
  if (!isOpenClawEntry) {
    return;
  }
  if (!looksLikeClaworksStateEnv(env)) {
    return;
  }
  if (_misEntryWarned) {
    return;
  }
  _misEntryWarned = true;
  env._CLAWORKS_MISENTRY_WARNED = "1";
  process.stderr.write(
    `[claworks] Warning: you launched via '${base}' but your state directory points to ClaWorks (.claworks). ` +
      `Use 'claworks.mjs' instead to ensure correct product isolation.\n`,
  );
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
  // CLAWORKS_STATE_DIR takes priority; fall back to OPENCLAW_STATE_DIR alias, then default.
  const stateDir =
    env.CLAWORKS_STATE_DIR?.trim() ||
    env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(home, ".claworks");

  // CLAWORKS_CONFIG takes priority; fall back to OPENCLAW_CONFIG_PATH alias, then default.
  const configPath =
    env.CLAWORKS_CONFIG?.trim() ||
    env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(stateDir, "claworks.json");

  env.CLAWORKS_PRODUCT = "1";
  // Keep both CLAWORKS_* and legacy OPENCLAW_* names consistent.
  env.CLAWORKS_STATE_DIR ??= stateDir;
  env.OPENCLAW_STATE_DIR ??= stateDir;
  env.CLAWORKS_CONFIG ??= configPath;
  env.OPENCLAW_CONFIG_PATH ??= configPath;
  env.CLAWORKS_GATEWAY_PORT ??= String(CLAWORKS_DEFAULT_GATEWAY_PORT);
  env.OPENCLAW_GATEWAY_PORT ??= String(CLAWORKS_DEFAULT_GATEWAY_PORT);
}

/** Detect `claworks` CLI invocation and enable product mode. */
export function detectAndApplyClaworksCli(env: NodeJS.ProcessEnv = process.env): void {
  const argv1 = env._CLAWORKS_ARGV1 ?? process.argv[1] ?? "";
  const base = path.basename(argv1);
  if (base === "claworks" || base === "claworks.mjs" || base === "claworks.js") {
    env.CLAWORKS_PRODUCT = "1";
  }
  // Also infer product mode from state dir or config path pointing to ClaWorks
  if (!env.CLAWORKS_PRODUCT && looksLikeClaworksStateEnv(env)) {
    env.CLAWORKS_PRODUCT = "1";
  }
  applyClaworksProductEnv(env);
}
