import os from "node:os";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../runtime.js";

type MatrixSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateRootDir?: string;
};

function resolveStateDirOverride(
  options: MatrixSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  return (
    options.stateDir ||
    options.stateRootDir ||
    getMatrixRuntime().state.resolveStateDir(options.env ?? process.env, os.homedir)
  );
}

export function resolveMatrixSqliteStateKey(options: MatrixSqliteStateOptions | undefined): string {
  return resolveStateDirOverride(options) ?? "";
}

export function resolveMatrixSqliteStateEnv(
  options: MatrixSqliteStateOptions | undefined,
): NodeJS.ProcessEnv | undefined {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return options?.env;
  }
  return {
    ...(options?.env ?? process.env),
    OPENCLAW_STATE_DIR: stateDir,
  };
}

export async function updateMatrixKeyedState<T>(
  store: PluginStateKeyedStore<T, 2>,
  key: string,
  update: (current: T | undefined) => T | undefined,
  onUndefined: "keep" | "skip" = "keep",
): Promise<boolean> {
  let observation = await store.observe(key);
  for (;;) {
    const value = update(observation.value);
    if (value === undefined && onUndefined === "skip") {
      return false;
    }
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      value === undefined
        ? { operation: "update", action: "keep" }
        : { operation: "update", action: "set", value },
    );
    if (result.status !== "conflict") {
      return true;
    }
    observation = result.current;
  }
}
