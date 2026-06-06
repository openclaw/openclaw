/** Repairs ACP sessions whose JSON store row exists but SQLite metadata was lost. */
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { readAcpSessionEntry } from "../runtime/session-meta.js";
import { resolveAcpAgentFromSessionKey } from "./manager.utils.js";

function resolveRepairMode(entry: SessionEntry): AcpRuntimeSessionMode {
  // Only hub-delegated workers carry an explicit persistent lifecycle marker.
  if (entry.hubDelegated) {
    return "persistent";
  }
  return "oneshot";
}

export function shouldRepairMissingAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  backendId?: string;
} | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !isAcpSessionKey(sessionKey)) {
    return null;
  }
  const storeEntry = readAcpSessionEntry({
    sessionKey,
    cfg: params.cfg,
    clone: false,
  });
  if (!storeEntry?.entry || storeEntry.acp) {
    return null;
  }
  return {
    sessionKey,
    agent: resolveAcpAgentFromSessionKey(sessionKey),
    mode: resolveRepairMode(storeEntry.entry),
    backendId: params.cfg.acp?.backend,
  };
}

export function hasPersistedAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): boolean {
  return Boolean(
    readAcpSessionEntry({
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      clone: false,
    })?.acp,
  );
}
