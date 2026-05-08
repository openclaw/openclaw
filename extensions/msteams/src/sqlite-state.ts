import { getMSTeamsRuntime } from "./runtime.js";

export type MSTeamsSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
};

function resolveStateDirOverride(
  options: MSTeamsSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.stateDir) {
    return options.stateDir;
  }
  if (options.homedir) {
    return getMSTeamsRuntime().state.resolveStateDir(options.env ?? process.env, options.homedir);
  }
  return options.env?.OPENCLAW_STATE_DIR?.trim() || undefined;
}

export async function withMSTeamsSqliteStateEnv<T>(
  options: MSTeamsSqliteStateOptions | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return await action();
  }
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    return await action();
  } finally {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

export function toPluginJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
