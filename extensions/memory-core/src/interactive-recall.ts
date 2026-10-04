import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryDreamingPluginConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import type { MemoryRecallParams } from "openclaw/plugin-sdk/memory-recall";
import { recordShortTermRecalls } from "./short-term-promotion-record.js";
import { isShortTermMemoryPath } from "./short-term-promotion-utils.js";

/** Only a surfaced, literal workspace-file excerpt can earn an interactive signal. */
export async function recordMemoryRecall(
  params: MemoryRecallParams,
  shouldRecordRecall: (result: MemoryRecallParams["results"][number]) => boolean,
): Promise<void> {
  params.assertActive();
  const dreaming = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.config),
    cfg: params.config,
  });
  if (!dreaming.enabled || !params.query.trim() || !path.isAbsolute(params.workspaceDir)) {
    return;
  }
  const results: MemoryRecallParams["results"] = [];
  for (const result of params.results) {
    if (
      result.source !== "memory" ||
      !isShortTermMemoryPath(result.path) ||
      path.isAbsolute(result.path) ||
      path.posix.normalize(result.path) !== result.path ||
      result.path.includes("\\") ||
      !result.path.startsWith("memory/") ||
      !Number.isInteger(result.startLine) ||
      !Number.isInteger(result.endLine) ||
      result.startLine < 1 ||
      result.endLine < result.startLine ||
      !result.snippet.trim() ||
      !Number.isFinite(result.score)
    ) {
      continue;
    }
    try {
      // The existing secure reader rejects escapes (including symlink parents).
      // Never convert virtual IDs, daily ingestion, or generated summaries into citations.
      const source = await readMemoryFile({
        workspaceDir: params.workspaceDir,
        relPath: result.path,
        from: result.startLine,
        lines: result.endLine - result.startLine + 1,
        maxChars: Math.max(12_000, result.snippet.length + 1),
      });
      if (source.status === "ok") {
        const body = source.text.split("\n").slice(0, source.lines).join("\n");
        const requestedLines = result.endLine - result.startLine + 1;
        // Native chunkMarkdown includes the terminal newline's split sentinel;
        // the secure reader deliberately omits that non-readable final line.
        const terminalNewlineChunk =
          !source.truncated &&
          source.lines === requestedLines - 1 &&
          (body.startsWith(result.snippet) || result.snippet === `${body}\n`);
        if (
          (source.lines === requestedLines && body.startsWith(result.snippet)) ||
          terminalNewlineChunk
        ) {
          results.push(result);
        }
      }
    } catch {
      // A missing, inaccessible, or noncanonical source supplies no grounded evidence.
    }
  }
  params.assertActive();
  if (results.length === 0) {
    return;
  }
  await recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results,
    shouldRecordRecall,
    timezone: dreaming.timezone,
    assertCurrent: params.assertActive,
  });
}
