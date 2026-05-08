import os from "node:os";
import path from "node:path";
import { getMatrixRuntime } from "../runtime.js";

export type MatrixSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  storagePath?: string;
};

function resolveStateDirOverride(
  options: MatrixSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.stateDir) {
    return options.stateDir;
  }
  if (options.storagePath) {
    return path.dirname(options.storagePath);
  }
  return getMatrixRuntime().state.resolveStateDir(options.env ?? process.env, os.homedir);
}

export function resolveMatrixSqliteStateKey(options: MatrixSqliteStateOptions | undefined): string {
  return resolveStateDirOverride(options) ?? "";
}

export function withMatrixSqliteStateEnv<T>(
  options: MatrixSqliteStateOptions | undefined,
  action: () => T,
): T {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return action();
  }
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    return action();
  } finally {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

export async function withMatrixSqliteStateEnvAsync<T>(
  options: MatrixSqliteStateOptions | undefined,
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
