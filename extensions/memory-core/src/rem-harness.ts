import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { DAILY_MEMORY_FILENAME_RE } from "./dreaming-ingestion-state.js";
import {
  filterRecallEntriesWithinLookback,
  previewRemDreaming,
  type RemDreamingPreview,
} from "./dreaming-phases.js";
import { listWorkspaceDirectory } from "./memory-workspace-files.js";
import { previewGroundedRemMarkdown, type GroundedRemPreviewResult } from "./rem-evidence.js";
import {
  filterLiveShortTermRecallEntries,
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
} from "./short-term-promotion.js";

export type PreviewRemHarnessOptions = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  grounded?: boolean;
  groundedInputPaths?: string[];
  groundedFileLimit?: number;
  includePromoted?: boolean;
  candidateLimit?: number;
  remPreviewLimit?: number;
  nowMs?: number;
};

export type PreviewRemHarnessResult = Awaited<ReturnType<typeof previewRemHarness>>;

function resolveRemPreviewLimit(configLimit: number, cap: number | undefined): number {
  if (configLimit <= 0) {
    return 0;
  }
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return configLimit;
  }
  return Math.max(0, Math.min(configLimit, Math.floor(cap)));
}

async function listWorkspaceDailyFiles(workspaceDir: string, limit?: number): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  let entries: string[];
  try {
    const dirEntries = await listWorkspaceDirectory(workspaceDir, memoryDir);
    entries = dirEntries
      .filter((entry) => entry.isFile() && DAILY_MEMORY_FILENAME_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const files = entries
    .map((name) => path.join(memoryDir, name))
    .toSorted((left, right) => left.localeCompare(right));
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || files.length <= limit) {
    return files;
  }
  return files.slice(-Math.floor(limit));
}

function resolveGroundedFileLimit(
  configLimit: number,
  cap: number | undefined,
): number | undefined {
  const normalizedCap = resolveOptionalIntegerOption(cap, { min: 1 });
  if (normalizedCap === undefined) {
    return configLimit;
  }
  return configLimit > 0 ? Math.min(configLimit, normalizedCap) : normalizedCap;
}

export async function previewRemHarness(params: PreviewRemHarnessOptions) {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const remConfig = resolveMemoryRemDreamingConfig(params);
  const deepConfig = resolveMemoryDeepDreamingConfig(params);
  const allRecallEntries = await readShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    nowMs,
  });
  const recallEntries = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    entries: filterRecallEntriesWithinLookback({
      entries: allRecallEntries,
      nowMs,
      lookbackDays: remConfig.lookbackDays,
    }),
  });
  const remPreviewLimit = resolveRemPreviewLimit(remConfig.limit, params.remPreviewLimit);
  const remSkipped = remPreviewLimit <= 0;
  const rem: RemDreamingPreview = remSkipped
    ? {
        sourceEntryCount: 0,
        reflections: [],
        candidateTruths: [],
        candidateKeys: [],
        bodyLines: [],
      }
    : previewRemDreaming({
        entries: recallEntries,
        limit: remPreviewLimit,
        minPatternStrength: remConfig.minPatternStrength,
      });

  let groundedInputPaths = params.groundedInputPaths ?? [];
  let grounded: GroundedRemPreviewResult | null = null;
  if (params.grounded) {
    if (groundedInputPaths.length === 0) {
      groundedInputPaths = await listWorkspaceDailyFiles(
        params.workspaceDir,
        resolveGroundedFileLimit(remConfig.limit, params.groundedFileLimit),
      );
    }
    grounded =
      groundedInputPaths.length > 0
        ? await previewGroundedRemMarkdown({
            workspaceDir: params.workspaceDir,
            inputPaths: groundedInputPaths,
          })
        : null;
  }

  const candidateLimit = resolveOptionalIntegerOption(params.candidateLimit, { min: 1 });
  const { candidates: rankedCandidates } = await rankShortTermPromotionCandidates({
    workspaceDir: params.workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    includePromoted: Boolean(params.includePromoted),
    recencyHalfLifeDays: deepConfig.recencyHalfLifeDays,
    maxAgeDays: deepConfig.maxAgeDays,
    nowMs,
    ...(candidateLimit ? { limit: candidateLimit + 1 } : {}),
  });
  const truncated = typeof candidateLimit === "number" && rankedCandidates.length > candidateLimit;
  const candidates =
    typeof candidateLimit === "number"
      ? rankedCandidates.slice(0, candidateLimit)
      : rankedCandidates;

  return {
    workspaceDir: params.workspaceDir,
    nowMs,
    remConfig,
    deepConfig,
    recallEntryCount: recallEntries.length,
    remSkipped,
    rem,
    groundedInputPaths,
    grounded,
    deep: {
      ...(candidateLimit ? { candidateLimit } : {}),
      candidateCount: candidates.length,
      truncated,
      candidates,
    },
  };
}
