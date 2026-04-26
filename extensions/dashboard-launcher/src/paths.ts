import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export class DashboardPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardPathError";
  }
}

export interface DashboardLogPaths {
  outLog: string;
  errLog: string;
}

const ENV_KEY = "OPENCLAW_DASHBOARD_PATH";

function openclawHome(): string {
  return resolve(homedir(), ".openclaw");
}

export function intentFile(): string {
  return resolve(openclawHome(), "dashboard.intent");
}

export function pidFile(): string {
  return resolve(openclawHome(), "dashboard.pid");
}

export function logPaths(): DashboardLogPaths {
  const dir = resolve(openclawHome(), "logs");
  return {
    outLog: resolve(dir, "dashboard.out.log"),
    errLog: resolve(dir, "dashboard.err.log"),
  };
}

export function dashboardPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[ENV_KEY];
  if (!raw || raw.trim() === "") {
    throw new DashboardPathError(
      `${ENV_KEY} is not set. Point it at the Mission Control checkout (the directory containing server.js).`,
    );
  }
  const normalized = resolve(raw.trim());
  let stat;
  try {
    stat = statSync(normalized);
  } catch {
    throw new DashboardPathError(`${ENV_KEY}=${raw} does not exist on disk.`);
  }
  if (!stat.isDirectory()) {
    throw new DashboardPathError(`${ENV_KEY}=${raw} is not a directory.`);
  }
  validateMissionControlRoot(normalized);
  return normalized;
}

export function validateMissionControlRoot(dir: string): void {
  const serverEntry = resolve(dir, "server.js");
  if (!existsSync(serverEntry)) {
    throw new DashboardPathError(
      `${dir} does not look like Mission Control: missing server.js. Set ${ENV_KEY} to the Mission Control checkout root.`,
    );
  }
}
