import path from "node:path";
import { resolveTaskStateDir } from "./task-registry.paths.js";

export function resolveFlowRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskStateDir(env), "flows");
}

export function resolveFlowRegistrySqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveFlowRegistryDir(env), "registry.sqlite");
}
