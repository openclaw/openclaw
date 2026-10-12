import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  formatMemoryDreamingDay,
  type MemoryDreamingPhaseName,
  type MemoryDreamingStorageConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { updateDeepDreamsFile } from "./dreaming-dreams-file.js";
import { getMemoryWorkspaceMaintenance, readWorkspaceText } from "./memory-workspace-files.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const PHASE_TITLES: Record<MemoryDreamingPhaseName, string> = {
  light: "Light Sleep",
  rem: "REM Sleep",
  deep: "Deep Sleep",
};

function resolveDailyMemoryPath(workspaceDir: string, epochMs: number, timezone?: string): string {
  const isoDay = formatMemoryDreamingDay(epochMs, timezone);
  return path.join(workspaceDir, "memory", `${isoDay}.md`);
}

function resolveSeparateReportPath(
  workspaceDir: string,
  phase: MemoryDreamingPhaseName,
  epochMs: number,
  timezone?: string,
): string {
  const isoDay = formatMemoryDreamingDay(epochMs, timezone);
  return path.join(workspaceDir, "memory", "dreaming", phase, `${isoDay}.md`);
}

function shouldWriteInline(storage: MemoryDreamingStorageConfig): boolean {
  return storage.mode === "inline" || storage.mode === "both";
}

function shouldWriteSeparate(storage: MemoryDreamingStorageConfig): boolean {
  return storage.mode === "separate" || storage.mode === "both" || storage.separateReports;
}

export async function replaceDreamingMarkdownFile(
  filePath: string,
  content: string,
  workspaceDir?: string,
): Promise<void> {
  const files = workspaceDir ? getMemoryWorkspaceMaintenance(workspaceDir) : undefined;
  if (files) {
    return await files.replaceReport(filePath, content);
  }
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const dirMode = (await fs.stat(directoryPath)).mode & 0o7777;
  await replaceFileAtomic({
    filePath,
    content,
    dirMode,
    mode: 0o600,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(filePath)}.dreaming`,
    syncTempFile: true,
    syncParentDir: true,
    throwOnCleanupError: true,
  });
}

type DreamingReportParams = {
  workspaceDir: string;
  bodyLines: string[];
  hasContent: boolean;
  nowMs?: number;
  timezone?: string;
  storage: MemoryDreamingStorageConfig;
};

async function writeDreamingReport(
  params: DreamingReportParams & { phase: MemoryDreamingPhaseName },
): Promise<{ inlinePath?: string; reportPath?: string }> {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const body =
    params.bodyLines.length > 0
      ? params.bodyLines.join("\n")
      : params.phase === "deep"
        ? "- No durable changes."
        : "- No notable updates.";
  let inlinePath: string | undefined;
  let reportPath: string | undefined;

  if (params.phase === "deep") {
    if (params.hasContent) {
      inlinePath = await updateDeepDreamsFile(params);
    }
  } else if (shouldWriteInline(params.storage)) {
    const candidatePath = resolveDailyMemoryPath(params.workspaceDir, nowMs, params.timezone);
    const original = await readWorkspaceText(params.workspaceDir, candidatePath).catch(
      (err: unknown) => {
        if (extractErrorCode(err) === "ENOENT") {
          return undefined;
        }
        throw err;
      },
    );
    // An existing empty file still owns its managed block; absence does not.
    if (params.hasContent || original !== undefined) {
      inlinePath = candidatePath;
      const updated = replaceManagedMarkdownBlock({
        original: original ?? "",
        heading: `## ${PHASE_TITLES[params.phase]}`,
        startMarker: `<!-- openclaw:dreaming:${params.phase}:start -->`,
        endMarker: `<!-- openclaw:dreaming:${params.phase}:end -->`,
        body,
      });
      await replaceDreamingMarkdownFile(
        inlinePath,
        withTrailingNewline(updated),
        params.workspaceDir,
      );
    }
  }

  if (params.hasContent && shouldWriteSeparate(params.storage)) {
    reportPath = resolveSeparateReportPath(
      params.workspaceDir,
      params.phase,
      nowMs,
      params.timezone,
    );
    const report = `# ${PHASE_TITLES[params.phase]}\n\n${body}\n`;
    await replaceDreamingMarkdownFile(reportPath, report, params.workspaceDir);
  }

  await appendMemoryHostEvent(params.workspaceDir, {
    type: "memory.dream.completed",
    timestamp: resolveMemoryCoreTimestamp(nowMs),
    phase: params.phase,
    outcome: "completed",
    ...(params.phase === "deep" || inlinePath ? { inlinePath } : {}),
    ...(reportPath ? { reportPath } : {}),
    lineCount: params.bodyLines.length,
    storageMode: params.storage.mode,
  });

  return {
    ...(inlinePath ? { inlinePath } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

export async function writeDailyDreamingPhaseBlock(
  params: DreamingReportParams & { phase: Exclude<MemoryDreamingPhaseName, "deep"> },
): Promise<{ inlinePath?: string; reportPath?: string }> {
  return await writeDreamingReport(params);
}

export async function writeDeepDreamingReport(
  params: DreamingReportParams,
): Promise<string | undefined> {
  return (await writeDreamingReport({ ...params, phase: "deep" })).reportPath;
}
