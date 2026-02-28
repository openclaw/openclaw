/**
 * Observation Store — Persistence layer for the observation log.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveWorkspaceDir } from "./common.js";
import { createEmptyLog, type ObservationLog } from "./observation-types.js";

function observationLogPath(api: OpenClawPluginApi, agentId: string): string {
  return join(resolveWorkspaceDir(api), "agents", agentId, "observation-log.json");
}

export async function loadObservationLog(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<ObservationLog> {
  const p = observationLogPath(api, agentId);
  try {
    const data = JSON.parse(await readFile(p, "utf-8"));
    return data as ObservationLog;
  } catch {
    return createEmptyLog();
  }
}

export async function saveObservationLog(
  api: OpenClawPluginApi,
  agentId: string,
  log: ObservationLog,
): Promise<void> {
  const p = observationLogPath(api, agentId);
  await mkdir(dirname(p), { recursive: true });

  // Atomic write: write to temp then rename
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(log, null, 2), "utf-8");
  await rename(tmp, p);
}
