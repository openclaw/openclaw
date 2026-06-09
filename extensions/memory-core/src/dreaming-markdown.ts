// Memory Core plugin module implements dreaming markdown behavior.
import fs from "node:fs/promises";
import path from "node:path";
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
import { updateDreamsFile } from "./dreaming-narrative.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DAILY_PHASE_HEADINGS: Record<Exclude<MemoryDreamingPhaseName, "deep">, string> = {
  light: "## Light Sleep",
  rem: "## REM Sleep",
};

const DAILY_PHASE_LABELS: Record<Exclude<MemoryDreamingPhaseName, "deep">, string> = {
  light: "light",
  rem: "rem",
};

function resolvePhaseMarkers(phase: Exclude<MemoryDreamingPhaseName, "deep">): {
  start: string;
  end: string;
} {
  const label = DAILY_PHASE_LABELS[phase];
  return {
    start: `<!-- openclaw:dreaming:${label}:start -->`,
    end: `<!-- openclaw:dreaming:${label}:end -->`,
  };
}

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

export async function writeDailyDreamingPhaseBlock(params: {
  workspaceDir: string;
  phase: Exclude<MemoryDreamingPhaseName, "deep">;
  bodyLines: string[];
  nowMs?: number;
  timezone?: string;
  storage: MemoryDreamingStorageConfig;
}): Promise<{ inlinePath?: string; reportPath?: string }> {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No notable updates.";
  let inlinePath: string | undefined;
  let reportPath: string | undefined;

  if (shouldWriteInline(params.storage)) {
    inlinePath = resolveDailyMemoryPath(params.workspaceDir, nowMs, params.timezone);
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    const original = await fs.readFile(inlinePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const markers = resolvePhaseMarkers(params.phase);
    const updated = replaceManagedMarkdownBlock({
      original,
      heading: DAILY_PHASE_HEADINGS[params.phase],
      startMarker: markers.start,
      endMarker: markers.end,
      body,
    });
    await fs.writeFile(inlinePath, withTrailingNewline(updated), "utf-8");
  }

  if (shouldWriteSeparate(params.storage)) {
    reportPath = resolveSeparateReportPath(
      params.workspaceDir,
      params.phase,
      nowMs,
      params.timezone,
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const report = [
      `# ${params.phase === "light" ? "Light Sleep" : "REM Sleep"}`,
      "",
      body,
      "",
    ].join("\n");
    await fs.writeFile(reportPath, report, "utf-8");
  }

  await appendMemoryHostEvent(params.workspaceDir, {
    type: "memory.dream.completed",
    timestamp: resolveMemoryCoreTimestamp(nowMs),
    phase: params.phase,
    ...(inlinePath ? { inlinePath } : {}),
    ...(reportPath ? { reportPath } : {}),
    lineCount: params.bodyLines.length,
    storageMode: params.storage.mode,
  });

  return {
    ...(inlinePath ? { inlinePath } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

export async function writeDeepDreamingReport(params: {
  workspaceDir: string;
  bodyLines: string[];
  nowMs?: number;
  timezone?: string;
  storage: MemoryDreamingStorageConfig;
}): Promise<string | undefined> {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  const deepSection = `## Deep Sleep\n\n${body}\n`;

  // Route the ## Deep Sleep section through the shared Dreams file
  // infrastructure so the summary benefits from the existing resolver
  // (lowercase dreams.md → DREAMS.md), file lock, atomic write, and
  // symlink / non-file guard.  The section sits outside the diary
  // markers so it stays separate from narrative diary entries.
  await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing) => {
      // Allow ## Deep Sleep to appear anywhere, including at file start.
      const deepHeading = "## Deep Sleep\n";
      const deepMarker = "\n" + deepHeading;
      let deepIndex = existing.indexOf(deepMarker);
      if (deepIndex < 0 && existing.startsWith(deepHeading)) {
        deepIndex = 0;
      }
      let updated: string;
      if (deepIndex >= 0) {
        // Replace the existing ## Deep Sleep section.
        const markerLen = deepIndex === 0 ? deepHeading.length : deepMarker.length;
        const before = existing.slice(0, deepIndex);
        const afterMarker = existing.slice(deepIndex + markerLen);
        const nextHeader = afterMarker.search(/\n## /);
        const after =
          nextHeader >= 0 ? afterMarker.slice(nextHeader) : "";
        updated = before + deepSection + after;
      } else {
        // Append the ## Deep Sleep section at the end.
        updated = existing.endsWith("\n") ? existing + deepSection : existing + "\n" + deepSection;
      }
      return { content: updated, result: undefined };
    },
  });

  // Optionally write the separate deep report file when storage mode
  // requests it (mirrors the inline DREAMS.md section above).
  if (shouldWriteSeparate(params.storage)) {
    const reportPath = resolveSeparateReportPath(
      params.workspaceDir, "deep", nowMs, params.timezone,
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `# Deep Sleep\n\n${body}\n`, "utf-8");
    await appendMemoryHostEvent(params.workspaceDir, {
      type: "memory.dream.completed",
      timestamp: resolveMemoryCoreTimestamp(nowMs),
      phase: "deep",
      reportPath,
      lineCount: params.bodyLines.length,
      storageMode: params.storage.mode,
    });
    return reportPath;
  }

  await appendMemoryHostEvent(params.workspaceDir, {
    type: "memory.dream.completed",
    timestamp: resolveMemoryCoreTimestamp(nowMs),
    phase: "deep",
    lineCount: params.bodyLines.length,
    storageMode: params.storage.mode,
  });
  return undefined;
}
