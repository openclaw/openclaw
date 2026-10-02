import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
const WORKBOARD_DB_RELATIVE_PATH = ["plugins", "workboard", "workboard.sqlite"] as const;

export function resolveWorkboardSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...WORKBOARD_DB_RELATIVE_PATH);
}

export function resolveWorkboardSqliteWorkerModuleUrl(runtimeSource: string | undefined): URL {
  if (!runtimeSource) {
    throw new Error("Workboard requires runtime entrypoint metadata");
  }
  return new URL(
    `./src/sqlite-store.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}
