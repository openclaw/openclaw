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
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  ensureDreamingArtifactDirectory,
  updateDeepDreamsFile,
  writeDreamingArtifactFile,
} from "./dreaming-dreams-file.js";
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

function resolveDailyMemoryPath(
  workspaceDir: string,
  epochMs: number,
  timezone?: string,
  agentId?: string,
): string {
  const isoDay = formatMemoryDreamingDay(epochMs, timezone);
  if (agentId?.trim()) {
    return path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "agents",
      normalizeAgentId(agentId),
      "daily",
      `${isoDay}.md`,
    );
  }
  return path.join(workspaceDir, "memory", `${isoDay}.md`);
}

function resolveSeparateReportPath(
  workspaceDir: string,
  phase: MemoryDreamingPhaseName,
  epochMs: number,
  timezone?: string,
  agentId?: string,
): string {
  const isoDay = formatMemoryDreamingDay(epochMs, timezone);
  if (agentId?.trim()) {
    return path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "agents",
      normalizeAgentId(agentId),
      "reports",
      phase,
      `${isoDay}.md`,
    );
  }
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
  agentId?: string;
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
    inlinePath = resolveDailyMemoryPath(
      params.workspaceDir,
      nowMs,
      params.timezone,
      params.agentId,
    );
    await ensureDreamingArtifactDirectory({
      workspaceDir: params.workspaceDir,
      filePath: inlinePath,
    });
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
    await writeDreamingArtifactFile({
      workspaceDir: params.workspaceDir,
      filePath: inlinePath,
      content: withTrailingNewline(updated),
    });
  }

  if (shouldWriteSeparate(params.storage)) {
    reportPath = resolveSeparateReportPath(
      params.workspaceDir,
      params.phase,
      nowMs,
      params.timezone,
      params.agentId,
    );
    const report = [
      `# ${params.phase === "light" ? "Light Sleep" : "REM Sleep"}`,
      "",
      body,
      "",
    ].join("\n");
    await writeDreamingArtifactFile({
      workspaceDir: params.workspaceDir,
      filePath: reportPath,
      content: report,
    });
  }

  await appendMemoryHostEvent(
    params.workspaceDir,
    {
      type: "memory.dream.completed",
      timestamp: resolveMemoryCoreTimestamp(nowMs),
      phase: params.phase,
      ...(inlinePath ? { inlinePath } : {}),
      ...(reportPath ? { reportPath } : {}),
      lineCount: params.bodyLines.length,
      storageMode: params.storage.mode,
    },
    params.agentId,
  );

  return {
    ...(inlinePath ? { inlinePath } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

export async function writeDeepDreamingReport(params: {
  workspaceDir: string;
  agentId?: string;
  bodyLines: string[];
  nowMs?: number;
  timezone?: string;
  storage: MemoryDreamingStorageConfig;
}): Promise<string | undefined> {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  const inlinePath = await updateDeepDreamsFile({
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    bodyLines: params.bodyLines,
  });
  let reportPath: string | undefined;
  if (shouldWriteSeparate(params.storage)) {
    reportPath = resolveSeparateReportPath(
      params.workspaceDir,
      "deep",
      nowMs,
      params.timezone,
      params.agentId,
    );
    await writeDreamingArtifactFile({
      workspaceDir: params.workspaceDir,
      filePath: reportPath,
      content: `# Deep Sleep\n\n${body}\n`,
    });
  }
  await appendMemoryHostEvent(
    params.workspaceDir,
    {
      type: "memory.dream.completed",
      timestamp: resolveMemoryCoreTimestamp(nowMs),
      phase: "deep",
      inlinePath,
      ...(reportPath ? { reportPath } : {}),
      lineCount: params.bodyLines.length,
      storageMode: params.storage.mode,
    },
    params.agentId,
  );
  return reportPath;
}
