// Transcript Stats plugin entrypoint registers its OpenClaw integration.
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { definePluginEntry } from "./api.js";

interface TranscriptStats {
  sessionFilesScanned: number;
  totalMessages: number;
  messagesByRole: Record<string, number>;
  totalToolCalls: number;
  totalToolResults: number;
  totalBytes: number;
  firstTimestampMs?: number;
  lastTimestampMs?: number;
  longestMessageChars: number;
  longestMessageRole?: string;
  longestMessageSession?: string;
}

const DEFAULT_RECENT_LIMIT = 5;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRole(value: unknown): string {
  const trimmed = asTrimmedString(value);
  return trimmed || "unknown";
}

function resolveTranscriptDir(sessionsDir: string, agentId: string): string {
  return path.join(sessionsDir, agentId);
}

function resolveWorkspaceSessionsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "sessions");
}

interface JsonlLine {
  raw: string;
  parsed?: Record<string, unknown>;
}

function splitJsonlLines(content: string): JsonlLine[] {
  const lines: JsonlLine[] = [];
  let buffer = "";
  for (const ch of content) {
    if (ch === "\n") {
      if (buffer.length > 0) {
        lines.push({ raw: buffer });
      }
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  if (buffer.length > 0) {
    lines.push({ raw: buffer });
  }
  for (const line of lines) {
    try {
      line.parsed = JSON.parse(line.raw) as Record<string, unknown>;
    } catch {
      line.parsed = undefined;
    }
  }
  return lines;
}

function countToolBlock(block: unknown, kind: "toolCall" | "toolResult"): number {
  if (!block) {
    return 0;
  }
  if (Array.isArray(block)) {
    return block.length;
  }
  if (typeof block === "object") {
    return 1;
  }
  void kind;
  return 0;
}

export function computeTranscriptStats(params: {
  files: Array<{ sessionId: string; content: string }>;
}): TranscriptStats {
  const stats: TranscriptStats = {
    sessionFilesScanned: params.files.length,
    totalMessages: 0,
    messagesByRole: {},
    totalToolCalls: 0,
    totalToolResults: 0,
    totalBytes: 0,
    longestMessageChars: 0,
  };

  for (const file of params.files) {
    stats.totalBytes += Buffer.byteLength(file.content, "utf8");
    const lines = splitJsonlLines(file.content);
    for (const line of lines) {
      if (!line.parsed) {
        continue;
      }
      const message = line.parsed.message;
      if (!message || typeof message !== "object") {
        continue;
      }
      stats.totalMessages += 1;
      const messageObj = message as Record<string, unknown>;
      const role = normalizeRole(messageObj.role);
      stats.messagesByRole[role] = (stats.messagesByRole[role] ?? 0) + 1;

      const text = asTrimmedString(messageObj.text ?? messageObj.content);
      if (text.length > stats.longestMessageChars) {
        stats.longestMessageChars = text.length;
        stats.longestMessageRole = role;
        stats.longestMessageSession = file.sessionId;
      }

      const ts = messageObj.timestamp;
      if (typeof ts === "string") {
        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs)) {
          stats.firstTimestampMs =
            stats.firstTimestampMs === undefined ? tsMs : Math.min(stats.firstTimestampMs, tsMs);
          stats.lastTimestampMs =
            stats.lastTimestampMs === undefined ? tsMs : Math.max(stats.lastTimestampMs, tsMs);
        }
      }

      stats.totalToolCalls += countToolBlock(messageObj.tool_calls, "toolCall");
      stats.totalToolResults += countToolBlock(messageObj.tool_results, "toolResult");
    }
  }

  return stats;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }
  return parts.join(" ");
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function formatRoleBreakdown(byRole: Record<string, number>): string {
  const entries = Object.entries(byRole).toSorted((a, b) => b[1] - a[1]);
  return entries.length === 0
    ? "  (none)"
    : entries.map(([role, count]) => `  ${role}: ${count}`).join("\n");
}

export function formatTranscriptStatsReport(params: {
  stats: TranscriptStats;
  scopeLabel: string;
  topSessionsByMessages?: Array<{ sessionId: string; messages: number }>;
}): string {
  const { stats, scopeLabel, topSessionsByMessages = [] } = params;
  const lines: string[] = [];
  lines.push(`Transcript stats — ${scopeLabel}`);
  lines.push("");
  lines.push(`  session files scanned: ${stats.sessionFilesScanned}`);
  lines.push(`  total messages: ${stats.totalMessages}`);
  lines.push(`  total tool calls: ${stats.totalToolCalls}`);
  lines.push(`  total tool results: ${stats.totalToolResults}`);
  lines.push(`  total bytes: ${stats.totalBytes}`);
  lines.push("");
  lines.push("  messages by role:");
  lines.push(formatRoleBreakdown(stats.messagesByRole));
  lines.push("");
  if (
    stats.firstTimestampMs !== undefined &&
    stats.lastTimestampMs !== undefined &&
    stats.lastTimestampMs > stats.firstTimestampMs
  ) {
    lines.push(
      `  time span: ${formatTimestamp(stats.firstTimestampMs)} → ${formatTimestamp(
        stats.lastTimestampMs,
      )} (${formatDuration(stats.lastTimestampMs - stats.firstTimestampMs)})`,
    );
  } else if (stats.firstTimestampMs !== undefined) {
    lines.push(`  timestamp: ${formatTimestamp(stats.firstTimestampMs)}`);
  }
  lines.push("");
  lines.push(
    `  longest message: ${stats.longestMessageChars} chars${
      stats.longestMessageRole ? ` (role=${stats.longestMessageRole})` : ""
    }${stats.longestMessageSession ? ` session=${stats.longestMessageSession}` : ""}`,
  );
  if (topSessionsByMessages.length > 0) {
    lines.push("");
    lines.push(`  top ${topSessionsByMessages.length} sessions by message count:`);
    for (const entry of topSessionsByMessages) {
      lines.push(`    ${entry.sessionId}: ${entry.messages}`);
    }
  }
  return lines.join("\n");
}

interface FileSystemModule {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

function listSessionJsonlFiles(filesystem: FileSystemModule, dir: string): Promise<string[]> {
  return filesystem
    .readdir(dir)
    .then((entries) => entries.filter((entry) => entry.endsWith(".jsonl")).toSorted());
}

async function loadRecentSessions(params: {
  filesystem: FileSystemModule;
  sessionsDir: string;
  limit: number;
}): Promise<Array<{ sessionId: string; content: string }>> {
  const files = await listSessionJsonlFiles(params.filesystem, params.sessionsDir);
  const recent = files.slice(-Math.max(1, params.limit));
  const loaded: Array<{ sessionId: string; content: string }> = [];
  for (const fileName of recent) {
    const absolute = path.join(params.sessionsDir, fileName);
    const sessionId = fileName.replace(/\.jsonl$/i, "");
    const content = await filesystem.readFile(absolute);
    loaded.push({ sessionId, content });
  }
  return loaded;
}

const transcriptStatsParameters = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("workspace"), Type.Literal("agent"), Type.Literal("recent")]),
  ),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  recentLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  workspaceDir: Type.Optional(Type.String({ minLength: 1 })),
  sessionsDir: Type.Optional(Type.String({ minLength: 1 })),
});

type TranscriptStatsParams = {
  scope?: "workspace" | "agent" | "recent";
  agentId?: string;
  recentLimit?: number;
  workspaceDir?: string;
  sessionsDir?: string;
};

export default definePluginEntry({
  id: "transcript-stats",
  name: "Transcript Stats",
  description: "Aggregate counts over JSONL session transcripts.",
  register(api) {
    api.registerTool(
      {
        name: "transcript_stats",
        description:
          "Aggregate message counts, tool-call counts, byte sizes, and time span over OpenClaw session transcripts (.jsonl). Read-only; never modifies session files. Useful for diagnosing long-running agents or finding the largest session.",
        parameters: transcriptStatsParameters,
        async execute(_toolCallId, rawParams) {
          const params = (rawParams ?? {}) as TranscriptStatsParams;
          const scope = params.scope ?? "workspace";
          const recentLimit = params.recentLimit ?? DEFAULT_RECENT_LIMIT;

          let targetDir: string | undefined;
          let scopeLabel: string;

          if (scope === "agent") {
            if (!params.agentId) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: 'transcript_stats: `agentId` is required when scope is "agent".',
                  },
                ],
              };
            }
            const base =
              asTrimmedString(params.sessionsDir) ||
              (asTrimmedString(params.workspaceDir)
                ? resolveWorkspaceSessionsDir(asTrimmedString(params.workspaceDir))
                : "");
            if (!base) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: 'transcript_stats: provide `workspaceDir` or `sessionsDir` for scope "agent".',
                  },
                ],
              };
            }
            targetDir = resolveTranscriptDir(base, asTrimmedString(params.agentId));
            scopeLabel = `agent ${params.agentId} (${targetDir})`;
          } else if (scope === "recent") {
            const base =
              asTrimmedString(params.sessionsDir) ||
              (asTrimmedString(params.workspaceDir)
                ? resolveWorkspaceSessionsDir(asTrimmedString(params.workspaceDir))
                : "");
            if (!base) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: 'transcript_stats: provide `workspaceDir` or `sessionsDir` for scope "recent".',
                  },
                ],
              };
            }
            targetDir = base;
            scopeLabel = `last ${recentLimit} session(s) under ${base}`;
          } else {
            const base =
              asTrimmedString(params.sessionsDir) ||
              (asTrimmedString(params.workspaceDir)
                ? resolveWorkspaceSessionsDir(asTrimmedString(params.workspaceDir))
                : "");
            if (!base) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: 'transcript_stats: provide `workspaceDir` or `sessionsDir` for scope "workspace".',
                  },
                ],
              };
            }
            targetDir = base;
            scopeLabel = `workspace sessions (${base})`;
          }

          const filesystem: FileSystemModule = {
            readdir: (target) => fs.readdir(target),
            readFile: (target) => fs.readFile(target, "utf8"),
          };

          let files: Array<{ sessionId: string; content: string }>;
          try {
            files =
              scope === "recent"
                ? await loadRecentSessions({
                    filesystem,
                    sessionsDir: targetDir,
                    limit: recentLimit,
                  })
                : (
                    await Promise.all(
                      (
                        await listSessionJsonlFiles(filesystem, targetDir)
                      ).map(async (fileName) => {
                        const sessionId = fileName.replace(/\.jsonl$/i, "");
                        const content = await filesystem.readFile(path.join(targetDir, fileName));
                        return { sessionId, content };
                      }),
                    )
                  ).toSorted((a, b) => a.sessionId.localeCompare(b.sessionId));
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `transcript_stats: failed to read ${targetDir}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                },
              ],
            };
          }

          if (files.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Transcript stats — ${scopeLabel}\n\n(no .jsonl session files found)`,
                },
              ],
            };
          }

          const stats = computeTranscriptStats({ files });

          const perSessionStats =
            scope === "recent"
              ? files.map((file) =>
                  Object.assign({}, computeTranscriptStats({ files: [file] }), {
                    sessionId: file.sessionId,
                  }),
                )
              : undefined;

          const topSessionsByMessages = perSessionStats
            ? perSessionStats
                .toSorted((a, b) => b.totalMessages - a.totalMessages)
                .slice(0, Math.min(5, perSessionStats.length))
                .map(({ sessionId, totalMessages }) => ({ sessionId, messages: totalMessages }))
            : undefined;

          const report = formatTranscriptStatsReport({
            stats,
            scopeLabel,
            ...(topSessionsByMessages ? { topSessionsByMessages } : {}),
          });

          return {
            content: [{ type: "text" as const, text: report }],
          };
        },
      },
      { name: "transcript_stats" },
    );
  },
});
