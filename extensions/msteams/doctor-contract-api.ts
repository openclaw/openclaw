import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

type FeedbackLearningEntry = {
  sessionKey: string;
  learnings: string[];
  updatedAt: number;
};

const LEARNINGS_NAMESPACE = "feedback-learnings";
const MAX_LEARNING_ENTRIES = 10_000;

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function decodeSessionKey(fileStem: string): string | null {
  try {
    const decoded = Buffer.from(fileStem, "base64url").toString("utf8");
    return encodeSessionKey(decoded) === fileStem && decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function decodeLegacySanitizedSessionKey(fileStem: string): string | null {
  if (fileStem.startsWith("msteams_") && fileStem.length > "msteams_".length) {
    return `msteams:${fileStem.slice("msteams_".length)}`;
  }
  return null;
}

function resolveLearningSessionKey(fileStem: string): string | null {
  return decodeSessionKey(fileStem) ?? decodeLegacySanitizedSessionKey(fileStem);
}

function listAgentIds(config: { agents?: { list?: Array<{ id?: unknown }> } }): string[] {
  const ids = new Set<string>(["main"]);
  for (const agent of config.agents?.list ?? []) {
    if (typeof agent.id === "string" && agent.id.trim()) {
      ids.add(agent.id.trim());
    }
  }
  return [...ids];
}

function listCandidateStorePaths(params: {
  config: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0]["config"];
  env: NodeJS.ProcessEnv;
}): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(params.config.session?.store, { env: params.env }));
  for (const agentId of listAgentIds(params.config)) {
    paths.add(resolveStorePath(params.config.session?.store, { agentId, env: params.env }));
  }
  return [...paths];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listLegacyLearningFiles(
  storePath: string,
): Promise<Array<{ sessionKey: string | null; filePath: string; learnings: string[] }>> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.readdir(storePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const suffix = ".learnings.json";
  const files: Array<{ sessionKey: string | null; filePath: string; learnings: string[] }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) {
      continue;
    }
    const fileStem = entry.name.slice(0, -suffix.length);
    const sessionKey = resolveLearningSessionKey(fileStem);
    const filePath = path.join(storePath, entry.name);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        const learnings = parsed.filter((item): item is string => typeof item === "string");
        if (learnings.length > 0) {
          files.push({ sessionKey, filePath, learnings: learnings.slice(-10) });
        }
      }
    } catch {
      // Malformed legacy feedback notes are ignored by migration.
    }
  }
  return files;
}

async function archiveLegacySource(params: {
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Microsoft Teams feedback-learning source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(
      `Archived Microsoft Teams feedback-learning legacy source -> ${archivedPath}`,
    );
  } catch (err) {
    params.warnings.push(
      `Failed archiving Microsoft Teams feedback-learning legacy source: ${String(err)}`,
    );
  }
}

function mergeLearnings(legacy: string[], existing?: FeedbackLearningEntry): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const learning of [...legacy, ...(existing?.learnings ?? [])]) {
    if (seen.has(learning)) {
      continue;
    }
    seen.add(learning);
    merged.push(learning);
  }
  return merged.slice(-10);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "msteams-feedback-learnings-json-to-plugin-state",
    label: "Microsoft Teams feedback learnings",
    async detectLegacyState(params) {
      const files = (
        await Promise.all(
          listCandidateStorePaths(params).map((storePath) => listLegacyLearningFiles(storePath)),
        )
      ).flat();
      if (files.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Microsoft Teams feedback learnings: ${files.length} ${files.length === 1 ? "file" : "files"} -> plugin state (${LEARNINGS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const files = (
        await Promise.all(
          listCandidateStorePaths(params).map((storePath) => listLegacyLearningFiles(storePath)),
        )
      ).flat();
      const store = params.context.openPluginStateKeyedStore<FeedbackLearningEntry>({
        namespace: LEARNINGS_NAMESPACE,
        maxEntries: MAX_LEARNING_ENTRIES,
      });
      let imported = 0;
      for (const file of files) {
        if (!file.sessionKey) {
          warnings.push(
            `Left Microsoft Teams feedback-learning source in place because its legacy filename cannot be mapped to a session key: ${file.filePath}`,
          );
          continue;
        }
        const key = encodeSessionKey(file.sessionKey);
        const existing = await store.lookup(key);
        await store.register(key, {
          sessionKey: existing?.sessionKey ?? file.sessionKey,
          learnings: mergeLearnings(file.learnings, existing),
          updatedAt: Date.now(),
        });
        imported++;
        await archiveLegacySource({ filePath: file.filePath, changes, warnings });
      }
      if (imported > 0) {
        changes.unshift(
          `Migrated ${imported} Microsoft Teams feedback-learning ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      return { changes, warnings };
    },
  },
];
