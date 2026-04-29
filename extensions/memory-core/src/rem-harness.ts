import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  extractDailyMemoryDayFromPath,
  filterOutSessionSummaryDailyMemoryFiles,
  listDailyMemoryFiles,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  filterRecallEntriesWithinLookback,
  previewRemDreaming,
  type RemDreamingPreview,
} from "./dreaming-phases.js";
import { previewGroundedRemMarkdown, type GroundedRemPreviewResult } from "./rem-evidence.js";
import {
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  type PromotionCandidate,
} from "./short-term-promotion.js";

type MemoryRemHarnessRemConfig = ReturnType<typeof resolveMemoryRemDreamingConfig>;
type MemoryRemHarnessDeepConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;

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

export type PreviewRemHarnessResult = {
  workspaceDir: string;
  nowMs: number;
  remConfig: MemoryRemHarnessRemConfig;
  deepConfig: MemoryRemHarnessDeepConfig;
  recallEntryCount: number;
  remSkipped: boolean;
  rem: RemDreamingPreview;
  groundedInputPaths: string[];
  grounded: GroundedRemPreviewResult | null;
  deep: {
    candidateLimit?: number;
    candidateCount: number;
    truncated: boolean;
    candidates: PromotionCandidate[];
  };
};

function normalizeOptionalPositiveLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function resolveRemPreviewLimit(configLimit: number, cap: number | undefined): number {
  if (configLimit <= 0) {
    return 0;
  }
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return configLimit;
  }
  return Math.max(0, Math.min(configLimit, Math.floor(cap)));
}

function createSkippedRemPreview(): RemDreamingPreview {
  return {
    sourceEntryCount: 0,
    reflections: [],
    candidateTruths: [],
    candidateKeys: [],
    bodyLines: [],
  };
}

async function listWorkspaceDailyFiles(
  workspaceDir: string,
  dayLimit?: number,
  fileLimit?: number,
): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const historicalFiles = (
      await listDailyMemoryFiles(memoryDir, {
        tolerateDirectoryErrors: false,
      })
    ).map((entry) => entry.absolutePath);
    const normalizedDayLimit =
      typeof dayLimit === "number" && Number.isFinite(dayLimit) && dayLimit > 0
        ? Math.floor(dayLimit)
        : undefined;
    const normalizedFileLimit =
      typeof fileLimit === "number" && Number.isFinite(fileLimit) && fileLimit > 0
        ? Math.floor(fileLimit)
        : undefined;
    if (!normalizedDayLimit && !normalizedFileLimit) {
      return await filterOutSessionSummaryDailyMemoryFiles(historicalFiles, {
        tolerateReadErrors: false,
      });
    }
    const filesByDay = new Map<string, string[]>();
    for (const filePath of historicalFiles) {
      const isoDay = extractDailyMemoryDayFromPath(filePath);
      if (!isoDay) {
        continue;
      }
      const dayFiles = filesByDay.get(isoDay);
      if (dayFiles) {
        dayFiles.push(filePath);
        continue;
      }
      filesByDay.set(isoDay, [filePath]);
    }
    const selectedDayFiles: string[][] = [];
    let selectedDayCount = 0;
    let selectedFileCount = 0;
    const orderedDays = [...filesByDay.keys()];
    for (let index = orderedDays.length - 1; index >= 0; index -= 1) {
      const dayFiles = filesByDay.get(orderedDays[index] ?? "");
      if (!dayFiles || dayFiles.length === 0) {
        continue;
      }
      const filteredDayFiles = await filterOutSessionSummaryDailyMemoryFiles(dayFiles, {
        tolerateReadErrors: false,
      });
      if (filteredDayFiles.length === 0) {
        continue;
      }
      let cappedDayFiles = filteredDayFiles;
      if (normalizedFileLimit) {
        const remaining = normalizedFileLimit - selectedFileCount;
        if (remaining <= 0) {
          break;
        }
        cappedDayFiles = filteredDayFiles.slice(0, remaining);
        selectedFileCount += cappedDayFiles.length;
      }
      selectedDayFiles.unshift(cappedDayFiles);
      selectedDayCount += 1;
      if (
        (normalizedDayLimit && selectedDayCount >= normalizedDayLimit) ||
        (normalizedFileLimit && selectedFileCount >= normalizedFileLimit)
      ) {
        break;
      }
    }
    return selectedDayFiles.flat();
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function resolveGroundedFileLimit(cap: number | undefined): number | undefined {
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return undefined;
  }
  return Math.max(1, Math.floor(cap));
}

export async function previewRemHarness(
  params: PreviewRemHarnessOptions,
): Promise<PreviewRemHarnessResult> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const remConfig = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  const deepConfig = resolveMemoryDeepDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  const allRecallEntries = await readShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    nowMs,
  });
  const recallEntries = filterRecallEntriesWithinLookback({
    entries: allRecallEntries,
    nowMs,
    lookbackDays: remConfig.lookbackDays,
  });
  const remPreviewLimit = resolveRemPreviewLimit(remConfig.limit, params.remPreviewLimit);
  const remSkipped = remConfig.limit <= 0 || remPreviewLimit <= 0;
  const rem = remSkipped
    ? createSkippedRemPreview()
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
        remConfig.limit,
        resolveGroundedFileLimit(params.groundedFileLimit),
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

  const candidateLimit = normalizeOptionalPositiveLimit(params.candidateLimit);
  const rankedCandidates = await rankShortTermPromotionCandidates({
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
