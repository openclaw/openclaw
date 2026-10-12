import path from "node:path";
import {
  legacyStateFileExists,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  readMemoryCoreWorkspaceEntries,
} from "../dreaming-state.js";
import { resolveConfiguredWorkspaces } from "./doctor-workspaces.js";

const RETIRED_DREAMING_SOURCES: readonly {
  label: string;
  fileName: string;
  namespaces: readonly string[];
  metaKey?: string;
}[] = [
  {
    label: "daily ingestion",
    fileName: "daily-ingestion.json",
    namespaces: [DREAMING_DAILY_INGESTION_NAMESPACE],
  },
  {
    label: "session ingestion",
    fileName: "session-ingestion.json",
    namespaces: [
      DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
    ],
  },
  {
    label: "short-term recall",
    fileName: "short-term-recall.json",
    namespaces: [SHORT_TERM_RECALL_NAMESPACE],
    metaKey: "recall",
  },
  {
    label: "phase signals",
    fileName: "phase-signals.json",
    namespaces: [SHORT_TERM_PHASE_SIGNAL_NAMESPACE],
    metaKey: "phase",
  },
];

async function unsupportedDreamingSources(
  params: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
): Promise<string[]> {
  configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
  const warnings: string[] = [];
  for (const workspaceDir of await resolveConfiguredWorkspaces(params.config, params.env)) {
    const sources = [];
    for (const source of RETIRED_DREAMING_SOURCES) {
      const filePath = path.join(workspaceDir, "memory", ".dreams", source.fileName);
      if (await legacyStateFileExists(filePath)) {
        sources.push({ ...source, filePath });
      }
    }
    if (sources.length === 0) {
      continue;
    }
    const acknowledgements = await readMemoryCoreWorkspaceEntries({
      namespace: "legacy-dreaming-source-acknowledgements",
      workspaceDir,
    });
    const metadata = await readMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
    });
    for (const source of sources) {
      // Empty ingestion stores have no marker except an existing migration acknowledgement.
      if (
        acknowledgements.some((entry) => entry.key === `legacy-source:${source.label}`) ||
        (source.metaKey && metadata.some((entry) => entry.key === source.metaKey))
      ) {
        continue;
      }
      const entries = await Promise.all(
        source.namespaces.map((namespace) =>
          readMemoryCoreWorkspaceEntries({ namespace, workspaceDir }),
        ),
      );
      if (entries.some((rows) => rows.length > 0)) {
        continue;
      }
      warnings.push(
        `Memory Core ${source.label}: upgrades from pre-July-2026 dreaming JSON are no longer migrated (${source.filePath}). No canonical SQLite state was found; an empty ingestion store cannot be distinguished from unmigrated state. Restore a backup produced by a July 2026 or newer release, or back up and move this retired file aside after verifying the SQLite state, then rerun openclaw doctor --fix. The file was left unchanged.`,
      );
    }
  }
  return warnings;
}

export const dreamingStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-dreams-json-to-sqlite",
  label: "Memory Core unsupported dreaming JSON",
  collectBackupResources: () => [],
  async detectLegacyState(params) {
    const warnings = await unsupportedDreamingSources(params);
    return warnings.length > 0 ? { preview: warnings.map((warning) => `- ${warning}`) } : null;
  },
  async migrateLegacyState(params) {
    return { changes: [], warnings: await unsupportedDreamingSources(params) };
  },
};
