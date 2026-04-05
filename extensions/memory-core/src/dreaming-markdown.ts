import fs from "node:fs/promises";
import path from "node:path";
import {
  formatMemoryDreamingDay,
  type MemoryDreamingPhaseName,
  type MemoryDreamingStorageConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";

const DAILY_PHASE_HEADINGS: Record<Exclude<MemoryDreamingPhaseName, "deep">, string> = {
  light: "## Light Sleep",
  rem: "## REM Sleep",
};

const DAILY_PHASE_LABELS: Record<Exclude<MemoryDreamingPhaseName, "deep">, string> = {
  light: "light",
  rem: "rem",
};

const DREAMS_FILENAME = "dreams.md";

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
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No notable updates.";
  let inlinePath: string | undefined;
  let reportPath: string | undefined;

  if (shouldWriteInline(params.storage)) {
    inlinePath = resolveDreamsPath(params.workspaceDir);
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    const original = await fs.readFile(inlinePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const markers = resolvePhaseMarkers(params.phase);
    const updated = replaceManagedBlock({
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
