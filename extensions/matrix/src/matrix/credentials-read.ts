import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixCredentialsDir as resolveSharedMatrixCredentialsDir,
  resolveMatrixCredentialsPath as resolveSharedMatrixCredentialsPath,
} from "../storage-paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

type MatrixCredentialsFileLoadResult =
  | {
      kind: "loaded";
      credentials: MatrixStoredCredentials | null;
    }
  | {
      kind: "missing";
    };

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  try {
    return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  } catch {
    // Some config-only helpers read stored credentials before the Matrix plugin
    // runtime is installed. Fall back to the standard state-dir env contract.
    const override = env.OPENCLAW_STATE_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }
    const homeDir = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
    return path.join(homeDir, ".openclaw");
  }
}

function parseMatrixCredentialsFile(filePath: string): MatrixStoredCredentials | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
  if (
    typeof parsed.homeserver !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.accessToken !== "string"
  ) {
    return null;
  }
  return parsed as MatrixStoredCredentials;
}

function loadMatrixCredentialsFile(filePath: string): MatrixCredentialsFileLoadResult {
  try {
    return {
      kind: "loaded",
      credentials: parseMatrixCredentialsFile(filePath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
}

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): string {
  const resolvedStateDir = stateDir ?? resolveStateDir(env);
  return resolveSharedMatrixCredentialsDir(resolvedStateDir);
}

export function resolveMatrixCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): string {
  const resolvedStateDir = resolveStateDir(env);
  return resolveSharedMatrixCredentialsPath({ stateDir: resolvedStateDir, accountId });
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const currentPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    const current = loadMatrixCredentialsFile(currentPath);
    if (current.kind === "loaded") {
      return current.credentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  try {
    fs.unlinkSync(resolveMatrixCredentialsPath(env, accountId));
  } catch {
    // ignore
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string; accessToken?: string },
): boolean {
  if (!config.userId) {
    if (!config.accessToken) {
      return false;
    }
    return stored.homeserver === config.homeserver && stored.accessToken === config.accessToken;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
