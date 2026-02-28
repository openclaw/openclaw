import type { ClaudeSdkConfig } from "../../config/zod-schema.agent-runtime.js";

export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

export type ClaudeSubprocessEnvArgs = {
  claudeSdkConfig?: Pick<ClaudeSdkConfig, "configDir">;
  processEnv?: NodeJS.ProcessEnv;
  providerEnv?: Record<string, string>;
};

function cloneDefinedEnv(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(processEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function applyResolvedConfigDir(
  env: Record<string, string>,
  resolvedConfigDir: string | undefined,
): void {
  // Always normalize the child env to a single source of truth. If no override
  // resolved, the subprocess must not inherit an accidental CLAUDE_CONFIG_DIR.
  delete env[CLAUDE_CONFIG_DIR_ENV];
  if (resolvedConfigDir) {
    env[CLAUDE_CONFIG_DIR_ENV] = resolvedConfigDir;
  }
}

export function resolveClaudeConfigDir(
  args: Pick<ClaudeSubprocessEnvArgs, "claudeSdkConfig" | "processEnv">,
): string | undefined {
  const processEnv = args.processEnv ?? process.env;
  const fromConfig = args.claudeSdkConfig?.configDir?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromProcessEnv = processEnv[CLAUDE_CONFIG_DIR_ENV]?.trim();
  return fromProcessEnv || undefined;
}

export function resolveClaudeSubprocessEnv(
  args: ClaudeSubprocessEnvArgs,
): Record<string, string> | undefined {
  const processEnv = args.processEnv ?? process.env;
  const resolvedConfigDir = resolveClaudeConfigDir({
    claudeSdkConfig: args.claudeSdkConfig,
    processEnv,
  });
  const parentHadConfigDir = typeof processEnv[CLAUDE_CONFIG_DIR_ENV] === "string";

  if (args.providerEnv) {
    const env = { ...args.providerEnv };
    applyResolvedConfigDir(env, resolvedConfigDir);
    return env;
  }

  if (resolvedConfigDir || parentHadConfigDir) {
    const env = cloneDefinedEnv(processEnv);
    applyResolvedConfigDir(env, resolvedConfigDir);
    return env;
  }

  return undefined;
}
