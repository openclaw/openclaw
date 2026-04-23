import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveCronStyleNow } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { formatMemoryBlock, normalizeMemoryBlockText } from "./memory-blocks.js";

export type MemoryAddResult =
  | { action: "created"; path: string; text: string }
  | { action: "failed"; error: "text_required" | "write_failed"; message?: string };

type MemoryAddTimeConfig = {
  agents?: {
    defaults?: {
      userTimezone?: string;
    };
  };
};

function formatMemoryDate(date = new Date(), cfg?: MemoryAddTimeConfig): string {
  const { userTimezone } = resolveCronStyleNow(cfg ?? {}, date.getTime());
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: userTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return date.toISOString().slice(0, 10);
}

async function appendMemoryBlock(params: {
  workspaceDir: string;
  normalizedText: string;
  cfg?: MemoryAddTimeConfig;
  now?: Date;
}): Promise<{ relPath: string; normalizedText: string }> {
  const relPath = `memory/${formatMemoryDate(params.now, params.cfg)}.md`;
  const absPath = path.join(params.workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  let prefix = "";
  try {
    const existing = await fs.readFile(absPath, "utf-8");
    if (existing.length > 0 && !existing.endsWith("\n\n")) {
      prefix = existing.endsWith("\n") ? "\n" : "\n\n";
    }
  } catch {}
  await fs.appendFile(absPath, `${prefix}${formatMemoryBlock(params.normalizedText)}`, "utf-8");
  return { relPath, normalizedText: params.normalizedText };
}

export async function addMemoryBlock(params: {
  workspaceDir: string;
  text: string;
  cfg?: MemoryAddTimeConfig;
  now?: Date;
}): Promise<MemoryAddResult> {
  const normalizedText = normalizeMemoryBlockText(params.text);
  if (!normalizedText) {
    return { action: "failed", error: "text_required" };
  }

  try {
    const written = await appendMemoryBlock({
      workspaceDir: params.workspaceDir,
      normalizedText,
      cfg: params.cfg,
      now: params.now,
    });
    return {
      action: "created",
      path: written.relPath,
      text: written.normalizedText,
    };
  } catch (error) {
    return {
      action: "failed",
      error: "write_failed",
      message: formatErrorMessage(error),
    };
  }
}
