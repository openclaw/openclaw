import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

function resolveStateDirFallback(): string {
  const override = (process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || "").trim();
  if (override) return override;
  return path.join(homedir(), ".openclaw");
}

let cachedRuntime: { state: { resolveStateDir: (env: NodeJS.ProcessEnv) => string } } | null = null;

export function bindStorageRuntime(runtime: unknown): void {
  const rt = runtime as Record<string, unknown> | null;
  if (rt && typeof (rt.state as Record<string, unknown>)?.resolveStateDir === "function") {
    cachedRuntime = rt as typeof cachedRuntime;
  }
}

function resolveWempDataRoot(): string {
  const stateDir = cachedRuntime
    ? cachedRuntime.state.resolveStateDir(process.env)
    : resolveStateDirFallback();
  return path.join(stateDir, "wemp");
}

function ensureRoot(): string {
  const root = resolveWempDataRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

export function getWempDataRoot(): string {
  return ensureRoot();
}

export function readJsonFile<T>(name: string, fallback: T): T {
  const file = path.join(ensureRoot(), name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(name: string, value: T): void {
  const file = path.join(ensureRoot(), name);
  const dir = path.dirname(file);
  // Fire-and-forget async write to avoid blocking the event loop.
  mkdir(dir, { recursive: true })
    .then(() => writeFile(file, JSON.stringify(value, null, 2), "utf8"))
    .catch((err) => {
      // eslint-disable-next-line no-console -- fire-and-forget write; log to stderr as fallback
      console.error(`[wemp] writeJsonFile failed for ${name}:`, err);
    });
}
