import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { appendCodexGitConfigParameters } from "./config-utils.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RUNTIME_INJECTION_ENVIRONMENT_KEYS = new Set([
  "NODE_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
]);

/** Merges app-server environment overrides while honoring clearEnv and unsafe key filtering. */
export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv" | "managedGitConfigParameters">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const source of [baseEnv, options.env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (!UNSAFE_ENVIRONMENT_KEYS.has(key)) {
        env[key] = value;
      }
    }
  }
  const normalizeKey = (key: string) => (platform === "win32" ? key.toLowerCase() : key);
  const keysToClear = new Set(
    (options.clearEnv ?? []).map((key) => normalizeKey(key.trim())).filter(Boolean),
  );
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    const runtimeInjection =
      RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(upperKey) || upperKey.startsWith("DYLD_");
    if (keysToClear.has(normalizeKey(key)) || runtimeInjection) {
      // Package managers and agent hosts may inject loader paths into their children. Codex does
      // not need them, so strip them before attestation and spawn instead of self-failing setup.
      delete env[key];
    }
  }
  if (options.managedGitConfigParameters !== undefined) {
    env.GIT_CONFIG_PARAMETERS = options.managedGitConfigParameters;
  }
  return env;
}

/** Keep inherited Git settings in the private process environment, outside thread config. */
export function withCodexAppServerGitConfig(
  options: CodexAppServerStartOptions,
  parameters: string,
): CodexAppServerStartOptions {
  const env = resolveCodexAppServerSpawnEnv(options);
  // Node selects the first sorted casing when Windows receives duplicate environment keys.
  const key =
    process.platform === "win32"
      ? Object.keys(env)
          .toSorted()
          .find((name) => name.toUpperCase() === "GIT_CONFIG_PARAMETERS")
      : "GIT_CONFIG_PARAMETERS";
  const inherited = key === undefined ? undefined : env[key];
  return {
    ...options,
    managedGitConfigParameters: appendCodexGitConfigParameters(inherited, parameters),
  };
}
