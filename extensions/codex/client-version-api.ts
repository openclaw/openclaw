import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { valid as validSemver } from "semver";
import {
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./src/app-server/config.js";
import {
  parseCodexVersion,
  resolveManagedCodexClientVersion,
  runCodexVersionCommand,
} from "./src/app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

/** How long a custom command's `--version` answer is reused before it is checked again. */
export const CUSTOM_CODEX_VERSION_TTL_MS = 5 * 60_000;

type CustomCodexVersion = { version: string; checkedAtMs: number };
const customCodexVersions = new Map<string, CustomCodexVersion>();

/** Test hook: forget every remembered custom command version. */
export function resetCustomCodexClientVersionsForTest(): void {
  customCodexVersions.clear();
}

/**
 * Codex client version for ChatGPT model discovery: the version of the binary
 * turns run, so listed models match what the backend accepts for them.
 * Managed starts report the selected installed Codex or the bundled pin. A
 * custom stdio command (appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN)
 * reports its own `--version`; remote app-servers keep the bundled pin.
 */
export async function resolveCodexClientVersion(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<string> {
  const { start } = resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfig(params.config?.plugins?.entries?.codex?.config),
    env: params.env,
  });
  if (start.transport !== "stdio") {
    return CODEX_APP_SERVER_VERSION;
  }
  if (start.commandSource === "config" || start.commandSource === "env") {
    return (
      (await resolveCustomCodexCommandVersion(start.command, params.env)) ??
      CODEX_APP_SERVER_VERSION
    );
  }
  if (start.commandSource !== "managed") {
    return CODEX_APP_SERVER_VERSION;
  }
  // Same agent-home Computer Use check that managed turns run before spawning.
  const agentStart = params.agentDir
    ? resolveCodexAppServerStartOptionsForAgent({
        startOptions: start,
        agentDir: params.agentDir,
        env: params.env,
      })
    : start;
  return resolveManagedCodexClientVersion(agentStart.managedCommandOrder ?? "package-first");
}

/**
 * `<command> --version` for a custom Codex command, remembered for a few minutes so
 * an in-place upgrade is picked up without a restart. A failed check (for example
 * while npm replaces the binary) reuses the last answer instead of dropping to the
 * bundled pin, which ChatGPT may not serve newer models to.
 */
async function resolveCustomCodexCommandVersion(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  const known = customCodexVersions.get(command);
  const nowMs = Date.now();
  if (known && nowMs - known.checkedAtMs < CUSTOM_CODEX_VERSION_TTL_MS) {
    return known.version;
  }
  try {
    const version = validSemver(parseCodexVersion(await runCodexVersionCommand(command, env)));
    if (version) {
      customCodexVersions.set(command, { version, checkedAtMs: nowMs });
      return version;
    }
  } catch {
    // Unavailable right now; fall through to the last known answer.
  }
  return known?.version;
}
