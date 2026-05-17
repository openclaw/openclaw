// Append-only threat log. In-memory + structured JSON to stderr.

import type {
  ThreatLogEntry,
  ScanResult,
  MessageSource,
  RecoveryAction,
  AgentShieldConfig,
} from "../types.js";

let memoryLog: ThreatLogEntry[] = [];
let logCounter = 0;

export function logThreat(
  scanResult: ScanResult,
  source: MessageSource,
  recoveryActions: RecoveryAction[],
  config: AgentShieldConfig
): ThreatLogEntry {
  const entry: ThreatLogEntry = {
    id: `tl-${++logCounter}-${Date.now()}`,
    timestamp: Date.now(),
    sessionId: source.sessionId,
    scanResult,
    source,
    recoveryActions,
  };

  if (config.threatLog === "memory" || config.threatLog === "both") {
    memoryLog.push(entry);
    // Don't let the in-memory log grow unbounded.
    if (memoryLog.length > 10_000) {
      memoryLog = memoryLog.slice(-5_000);
    }
  }

  // Until we wire into openclaw's logger, emit structured JSON to stderr
  // so the gateway's log pipeline can pick it up.
  if (config.threatLog === "file" || config.threatLog === "both") {
    const logLine = JSON.stringify({
      _type: "agent_shield_threat",
      ...entry,
    });
    process.stderr.write(logLine + "\n");
  }

  return entry;
}

export function queryLog(opts?: {
  sessionId?: string;
  since?: number;
  severity?: string;
  limit?: number;
}): ThreatLogEntry[] {
  let results = memoryLog;

  if (opts?.sessionId) {
    results = results.filter((e) => e.sessionId === opts.sessionId);
  }
  if (opts?.since) {
    results = results.filter((e) => e.timestamp >= opts.since!);
  }
  if (opts?.severity) {
    results = results.filter(
      (e) => e.scanResult.maxSeverity === opts.severity
    );
  }
  if (opts?.limit) {
    results = results.slice(-opts.limit);
  }

  return results;
}

export function getStats(): {
  totalScans: number;
  totalThreats: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  recoveryActions: number;
} {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let totalThreats = 0;
  let recoveryActions = 0;

  for (const entry of memoryLog) {
    for (const m of entry.scanResult.matches) {
      totalThreats++;
      bySeverity[m.severity] = (bySeverity[m.severity] || 0) + 1;
      byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    }
    recoveryActions += entry.recoveryActions.length;
  }

  return {
    totalScans: memoryLog.length,
    totalThreats,
    bySeverity,
    byCategory,
    recoveryActions,
  };
}

export function clearLog(): void {
  memoryLog = [];
  logCounter = 0;
}
