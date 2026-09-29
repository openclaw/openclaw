import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  archiveLegacyStateSource,
  legacyStateFileExists,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
  writeDailyIngestionState,
  writeSessionIngestionState,
} from "../dreaming-ingestion-state.js";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "../dreaming-state.js";
// Import from the defining modules, not the short-term-promotion barrel: the
// barrel pulls memory-host-events/kysely, which doctor enumeration cold-loads.
import { normalizeShortTermPhaseSignalStore } from "../short-term-promotion-store.js";
import { normalizeShortTermRecallStore } from "../short-term-promotion-utils.js";
import { resolveConfiguredWorkspaces } from "./doctor-workspaces.js";
import { dreamingStateComparison } from "./dreaming-state-comparison.js";

type LegacySource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

const LEGACY_DREAMING_STATE_DIR = path.join("memory", ".dreams");

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const workspaceDir of await resolveConfiguredWorkspaces(config, env)) {
    const candidates = [
      { label: "daily ingestion", fileName: "daily-ingestion.json" },
      { label: "session ingestion", fileName: "session-ingestion.json" },
      { label: "short-term recall", fileName: "short-term-recall.json" },
      { label: "phase signals", fileName: "phase-signals.json" },
    ];
    for (const candidate of candidates) {
      const filePath = path.join(workspaceDir, LEGACY_DREAMING_STATE_DIR, candidate.fileName);
      if (await legacyStateFileExists(filePath)) {
        sources.push({ workspaceDir, label: candidate.label, filePath });
      }
    }
  }
  return sources;
}

async function migrateDailyIngestion(source: LegacySource): Promise<number> {
  const state = normalizeDailyIngestionState(await readJsonFile(source.filePath));
  await writeDailyIngestionState(source.workspaceDir, state);
  return Object.keys(state.files).length;
}

async function migrateSessionIngestion(source: LegacySource): Promise<number> {
  const state = normalizeSessionIngestionState(await readJsonFile(source.filePath));
  await writeSessionIngestionState(source.workspaceDir, state);
  return Object.keys(state.files).length + Object.keys(state.seenMessages).length;
}

async function migrateShortTermStore(
  source: LegacySource,
  kind: "recall" | "phase",
): Promise<number> {
  const nowIso = new Date().toISOString();
  const raw = await readJsonFile(source.filePath);
  const state =
    kind === "recall"
      ? normalizeShortTermRecallStore(raw, nowIso)
      : normalizeShortTermPhaseSignalStore(raw, nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace:
        kind === "recall" ? SHORT_TERM_RECALL_NAMESPACE : SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: kind,
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migrateSource(source: LegacySource): Promise<number> {
  if (source.label === "daily ingestion") {
    return await migrateDailyIngestion(source);
  }
  if (source.label === "session ingestion") {
    return await migrateSessionIngestion(source);
  }
  return await migrateShortTermStore(
    source,
    source.label === "short-term recall" ? "recall" : "phase",
  );
}

export const dreamingStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-dreams-json-to-sqlite",
  label: "Memory Core dreaming state",
  async detectLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const sources = await collectLegacySources(params.config, params.env);
    if (sources.length === 0) {
      return null;
    }
    return {
      preview: sources.map(
        (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
      ),
    };
  },
  async migrateLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const changes: string[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    for (const source of await collectLegacySources(params.config, params.env)) {
      const targetHasRows = await dreamingStateComparison.targetHasRows(source);
      if (targetHasRows) {
        let sourceAcknowledged: boolean;
        try {
          sourceAcknowledged = await dreamingStateComparison.sourceIsAcknowledged(source);
        } catch (err) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be compared: ${String(err)}`,
          );
          continue;
        }
        if (sourceAcknowledged) {
          // Older releases may rewrite these rollback sources. The stored hash
          // keeps unchanged sources informational; rewritten sources fail closed.
          notices.push(
            `Retained acknowledged Memory Core ${source.label} legacy source for rollback: ${source.filePath}`,
          );
          continue;
        }
        // Each retired journal mirrors the SQLite namespaces used by the runtime.
        // Keep canonical state active and retain only the divergent rollback source.
        changes.push(
          `Resolved Memory Core ${source.label} legacy conflict by keeping canonical SQLite plugin state`,
        );
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: `Memory Core ${source.label} conflicting legacy source`,
          changes,
          warnings,
        });
        continue;
      }
      let imported: number;
      try {
        imported = await migrateSource(source);
      } catch (err) {
        warnings.push(
          `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be imported: ${String(err)}`,
        );
        continue;
      }
      changes.push(
        `Migrated Memory Core ${source.label} -> SQLite plugin state (${imported} row(s))`,
      );
      await archiveLegacyStateSource({
        filePath: source.filePath,
        label: `Memory Core ${source.label}`,
        changes,
        warnings,
      });
    }
    return {
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  },
};
