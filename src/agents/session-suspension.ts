import path from "node:path";
import { updateSessionStoreEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";

export async function suspendSession(params: {
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  sessionId: string;
  laneId?: string;
  reason: "quota_exhausted" | "manual" | "circuit_open";
  failedProvider: string;
  failedModel: string;
}) {
  if (!params.cfg) return;

  const { sessionKey, storePath } = resolveStoredSessionKeyForSessionId({
    cfg: params.cfg,
    sessionId: params.sessionId,
    agentId: params.agentDir ? path.basename(params.agentDir) : undefined,
  });

  if (!sessionKey) return;

  if (params.laneId) {
    setCommandLaneConcurrency(params.laneId, 0);
  }

  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    patch: {
      quotaSuspension: {
        schemaVersion: 1,
        suspendedAt: Date.now(),
        reason: params.reason,
        failedProvider: params.failedProvider,
        failedModel: params.failedModel,
        state: "suspended",
      },
    },
  });
}
