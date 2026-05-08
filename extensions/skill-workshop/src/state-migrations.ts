import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import {
  buildSkillWorkshopProposalEntryKey,
  SKILL_WORKSHOP_PLUGIN_ID,
  SKILL_WORKSHOP_PROPOSALS_NAMESPACE,
  SKILL_WORKSHOP_REVIEWS_NAMESPACE,
} from "./store.js";
import type { SkillProposal } from "./types.js";

type LegacySkillWorkshopStoreFile = {
  version?: unknown;
  proposals?: unknown;
  review?: unknown;
};

type SkillWorkshopReviewState = {
  turnsSinceReview: number;
  toolCallsSinceReview: number;
  lastReviewAt?: number;
};

function listLegacySkillWorkshopStoreFiles(sourceDir: string): string[] {
  try {
    return fs
      .readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{16}\.json$/iu.test(entry.name))
      .map((entry) => path.join(sourceDir, entry.name))
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function removeEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort: source files are removed individually after successful import.
  }
}

function normalizeReviewState(value: unknown): SkillWorkshopReviewState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    turnsSinceReview:
      typeof record.turnsSinceReview === "number" && Number.isFinite(record.turnsSinceReview)
        ? Math.max(0, Math.trunc(record.turnsSinceReview))
        : 0,
    toolCallsSinceReview:
      typeof record.toolCallsSinceReview === "number" &&
      Number.isFinite(record.toolCallsSinceReview)
        ? Math.max(0, Math.trunc(record.toolCallsSinceReview))
        : 0,
    ...(typeof record.lastReviewAt === "number" && Number.isFinite(record.lastReviewAt)
      ? { lastReviewAt: record.lastReviewAt }
      : {}),
  };
}

function isSkillProposal(value: unknown): value is SkillProposal {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function importLegacySkillWorkshopStoreFile(params: { filePath: string; env: NodeJS.ProcessEnv }): {
  imported: number;
  warnings: string[];
} {
  const storeKey = path.basename(params.filePath, ".json");
  const warnings: string[] = [];
  const parsed = JSON.parse(
    fs.readFileSync(params.filePath, "utf8"),
  ) as LegacySkillWorkshopStoreFile;
  let imported = 0;
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.filter(isSkillProposal) : [];
  for (const proposal of proposals) {
    upsertPluginStateMigrationEntry({
      pluginId: SKILL_WORKSHOP_PLUGIN_ID,
      namespace: SKILL_WORKSHOP_PROPOSALS_NAMESPACE,
      key: buildSkillWorkshopProposalEntryKey(storeKey, proposal.id),
      value: {
        version: 1,
        workspaceKey: storeKey,
        proposal,
      },
      createdAt:
        typeof proposal.createdAt === "number" && Number.isFinite(proposal.createdAt)
          ? proposal.createdAt
          : Date.now(),
      env: params.env,
    });
    imported++;
  }
  const review = normalizeReviewState(parsed.review);
  if (review) {
    upsertPluginStateMigrationEntry({
      pluginId: SKILL_WORKSHOP_PLUGIN_ID,
      namespace: SKILL_WORKSHOP_REVIEWS_NAMESPACE,
      key: storeKey,
      value: {
        version: 1,
        workspaceKey: storeKey,
        review,
      },
      createdAt: review.lastReviewAt ?? Date.now(),
      env: params.env,
    });
    imported++;
  }
  if (Array.isArray(parsed.proposals) && proposals.length !== parsed.proposals.length) {
    warnings.push(`Skipped invalid Skill Workshop proposal row(s): ${params.filePath}`);
  }
  fs.rmSync(params.filePath, { force: true });
  return { imported, warnings };
}

function importLegacySkillWorkshopStoreFiles(
  sourceDir: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of listLegacySkillWorkshopStoreFiles(sourceDir)) {
    try {
      const result = importLegacySkillWorkshopStoreFile({ filePath, env });
      imported += result.imported;
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(`Skipped invalid Skill Workshop state file ${filePath}: ${String(error)}`);
    }
  }
  removeEmptyDir(sourceDir);
  return { imported, warnings };
}

export function detectSkillWorkshopLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const sourceDir = path.join(params.stateDir, "skill-workshop");
  const files = listLegacySkillWorkshopStoreFiles(sourceDir);
  if (files.length === 0) {
    return [];
  }
  return [
    {
      kind: "custom",
      label: "Skill Workshop proposals",
      sourcePath: sourceDir,
      targetTable: `plugin_state_entries:${SKILL_WORKSHOP_PLUGIN_ID}/${SKILL_WORKSHOP_PROPOSALS_NAMESPACE}+${SKILL_WORKSHOP_REVIEWS_NAMESPACE}`,
      recordCount: files.length,
      apply: ({ env }) => {
        const result = importLegacySkillWorkshopStoreFiles(sourceDir, env);
        return {
          changes: [
            `Imported ${result.imported} Skill Workshop row(s) into SQLite plugin state (${SKILL_WORKSHOP_PLUGIN_ID}/${SKILL_WORKSHOP_PROPOSALS_NAMESPACE}, ${SKILL_WORKSHOP_PLUGIN_ID}/${SKILL_WORKSHOP_REVIEWS_NAMESPACE})`,
          ],
          warnings: result.warnings,
        };
      },
    },
  ];
}
