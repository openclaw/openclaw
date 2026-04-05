import fs from "node:fs/promises";
import path from "node:path";
import {
  formatMemoryDreamingDay,
  type MemoryDreamingPhaseName,
  type MemoryDreamingStorageConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";

const DAILY_PHASE_LABELS: Record<Exclude<MemoryDreamingPhaseName, "deep">, string> = {
  light: "light",
  rem: "rem",
};

const DREAMS_FILENAME = "DREAMS.md";

function resolvePhaseMarkers(
  phase: Exclude<MemoryDreamingPhaseName, "deep">,
  isoDay: string,
): {
  start: string;
  end: string;
} {
  const label = DAILY_PHASE_LABELS[phase];
  return {
    start: `<!-- openclaw:dreaming:${isoDay}:${label}:start -->`,
    end: `<!-- openclaw:dreaming:${isoDay}:${label}:end -->`,
  };
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function replaceManagedBlock(params: {
  original: string;
  heading: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): string {
  const managedBlock = `${params.heading}\n${params.startMarker}\n${params.body}\n${params.endMarker}`;
  const existingPattern = new RegExp(
    `${escapeRegex(params.heading)}\\n${escapeRegex(params.startMarker)}[\\s\\S]*?${escapeRegex(params.endMarker)}`,
    "m",
  );
  if (existingPattern.test(params.original)) {
    return params.original.replace(existingPattern, managedBlock);
  }
  const trimmed = params.original.trimEnd();
  if (trimmed.length === 0) {
    return `${managedBlock}\n`;
  }
  return `${trimmed}\n\n${managedBlock}\n`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveDreamsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DREAMS_FILENAME);
}

function resolveDreamsBlockHeading(
  phase: Exclude<MemoryDreamingPhaseName, "deep">,
  isoDay: string,
): string {
  return `## ${isoDay} - ${phase === "light" ? "Light Sleep" : "REM Sleep"}`;
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
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const isoDay = formatMemoryDreamingDay(nowMs, params.timezone);
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No notable updates.";
  let inlinePath: string | undefined;
  let reportPath: string | undefined;

  if (shouldWriteInline(params.storage)) {
    inlinePath = resolveDreamsPath(params.workspaceDir);
    const original = await fs.readFile(inlinePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const markers = resolvePhaseMarkers(params.phase, isoDay);
    const updated = replaceManagedBlock({
      original,
      heading: resolveDreamsBlockHeading(params.phase, isoDay),
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
  if (!shouldWriteSeparate(params.storage)) {
    return undefined;
  }
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const reportPath = resolveSeparateReportPath(params.workspaceDir, "deep", nowMs, params.timezone);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  await fs.writeFile(reportPath, `# Deep Sleep\n\n${body}\n`, "utf-8");
  return reportPath;
}
