import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedStructuredMemoryConfig } from "./config";
import {
  getOrOpenDatabase,
  scanExpiredRecords,
  scanAllActiveRecords,
  archiveRecord,
  closeAllDatabases,
} from "./db";
import { computeRelevance } from "./decay";
import type { MaintenanceResult } from "./types";

const MAX_SESSION_SCAN = 100;
const MAX_SESSION_ARCHIVE = 10;

function isProtected(record: { critical: 0 | 1; activate_at: string | null }): boolean {
  if (record.critical === 1) return true;
  if (record.activate_at && new Date(record.activate_at).getTime() > Date.now()) return true;
  return false;
}

export async function runSessionMaintenance(params: {
  agentId: string;
  config: ResolvedStructuredMemoryConfig;
}): Promise<MaintenanceResult> {
  const db = getOrOpenDatabase(params.agentId);

  const expired = scanExpiredRecords(db).filter((r) => !isProtected(r));
  let archivedExpired = 0;
  for (const record of expired.slice(0, MAX_SESSION_ARCHIVE)) {
    archiveRecord(db, record.id, "expired");
    archivedExpired++;
  }

  const active = scanAllActiveRecords(db).filter((r) => !isProtected(r));
  const toScan = active.slice(0, Math.min(MAX_SESSION_SCAN, active.length));
  let archivedDecayed = 0;

  for (const record of toScan) {
    if (archivedExpired + archivedDecayed >= MAX_SESSION_ARCHIVE) break;
    const relevance = computeRelevance(record, { decay: params.config.decay });
    if (relevance.should_archive) {
      archiveRecord(db, record.id, relevance.archive_reason ?? "decayed");
      archivedDecayed++;
    }
  }

  return {
    archived_expired: archivedExpired,
    archived_decayed: archivedDecayed,
    total_scanned: expired.length + toScan.length,
  };
}

export async function runFullMaintenanceCycle(params: {
  config: ResolvedStructuredMemoryConfig;
  api: OpenClawPluginApi;
}): Promise<Map<string, MaintenanceResult>> {
  const results = new Map<string, MaintenanceResult>();
  const cfg = params.api.config;
  const defaultAgentId = resolveDefaultAgentId(cfg);

  const agentIds = new Set<string>([defaultAgentId]);
  if (cfg.agents?.list) {
    for (const agent of Object.values(cfg.agents.list)) {
      if (agent && typeof agent === "object") {
        const agentObj = agent as Record<string, unknown>;
        const id = typeof agentObj.id === "string" ? agentObj.id : undefined;
        if (id) agentIds.add(id);
      }
    }
  }

  for (const agentId of agentIds) {
    try {
      const db = getOrOpenDatabase(agentId);

      const expired = scanExpiredRecords(db).filter((r) => !isProtected(r));
      let archivedExpired = 0;
      for (const record of expired) {
        archiveRecord(db, record.id, "expired");
        archivedExpired++;
      }

      const active = scanAllActiveRecords(db).filter((r) => !isProtected(r));
      let archivedDecayed = 0;
      for (const record of active) {
        const relevance = computeRelevance(record, { decay: params.config.decay });
        if (relevance.should_archive) {
          archiveRecord(db, record.id, relevance.archive_reason ?? "decayed");
          archivedDecayed++;
        }
        const salience = (record.importance * relevance.decay_factor * relevance.access_boost) / 10;
        db.prepare("UPDATE memory_records SET salience = ? WHERE id = ?").run(
          Math.max(0, Math.min(1, salience)),
          record.id,
        );
      }

      results.set(agentId, {
        archived_expired: archivedExpired,
        archived_decayed: archivedDecayed,
        total_scanned: expired.length + active.length,
      });
    } catch {
      // silent
    }
  }

  return results;
}
