/**
 * Output Formatting Helpers
 *
 * Formats episode data for display in chat replies and context injection.
 */

import type { EpisodeRow, EpisodeSearchResult } from "./db.js";
import type { Mem0Memory } from "./mem0-client.js";

/** Format a relative time string like "2 hours ago" or "3 days ago". */
export function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "1 day ago";
  }
  return `${days} days ago`;
}

/** Format episode search results for context injection. */
export function formatEpisodeContext(
  continuation: EpisodeRow | null,
  semantic: EpisodeSearchResult[],
): string {
  const sections: string[] = [];

  if (continuation) {
    sections.push(
      `- ${relativeTime(continuation.endedAt)}: ${continuation.summary}` +
        formatPendingTasks(continuation.tasksPending),
    );
  }

  for (const { episode } of semantic) {
    // Skip if same as continuation episode
    if (continuation && episode.episodeId === continuation.episodeId) {
      continue;
    }
    sections.push(
      `- ${relativeTime(episode.endedAt)}: ${episode.summary}` +
        formatPendingTasks(episode.tasksPending),
    );
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Relevant Past Sessions\n${sections.join("\n")}`;
}

function formatPendingTasks(tasks: string[]): string {
  if (tasks.length === 0) {
    return "";
  }
  const listed = tasks.slice(0, 3).join("; ");
  return `\n  Pending: ${listed}`;
}

/** Format episode search results for a /recall reply. */
export function formatRecallResults(
  episodes: EpisodeSearchResult[],
  memories: Mem0Memory[],
): string {
  const parts: string[] = [];

  if (memories.length > 0) {
    parts.push("**Long-Term Facts**");
    for (const mem of memories) {
      parts.push(`- ${mem.memory}`);
    }
  }

  if (episodes.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push("**Past Sessions**");
    for (const { episode, similarity } of episodes) {
      const pct = Math.round(similarity * 100);
      parts.push(`- [${pct}%] ${relativeTime(episode.endedAt)}: ${episode.summary.slice(0, 150)}`);
    }
  }

  if (parts.length === 0) {
    return "No memories found.";
  }

  return parts.join("\n");
}

/** Format the /memory dashboard output. */
export function formatMemoryDashboard(params: {
  episodeCount: number;
  latestEpisode: Date | null;
  mem0Count: number | null;
  mem0Healthy: boolean;
  dbHealthy: boolean;
}): string {
  const lines: string[] = ["**Memory Dashboard**", ""];

  lines.push(
    `Episodes: ${params.episodeCount}` +
      (params.latestEpisode ? ` (latest: ${relativeTime(params.latestEpisode)})` : ""),
  );

  if (params.mem0Count !== null) {
    lines.push(`Long-term memories: ${params.mem0Count}`);
  }

  lines.push("");
  lines.push(`Episode DB: ${params.dbHealthy ? "healthy" : "degraded"}`);
  lines.push(`Mem0: ${params.mem0Healthy ? "healthy" : "degraded"}`);

  return lines.join("\n");
}

/** Format episode details for display. */
export function formatEpisodeDetail(episode: EpisodeRow): string {
  const lines: string[] = [
    `**Episode** ${episode.episodeId.slice(0, 8)}`,
    `Session: ${episode.sourceSessionId}`,
    `Time: ${relativeTime(episode.endedAt)}`,
    "",
    episode.summary,
  ];

  if (episode.keyDecisions.length > 0) {
    lines.push("", "**Decisions:**");
    for (const d of episode.keyDecisions) {
      lines.push(`- ${d}`);
    }
  }

  if (episode.tasksPending.length > 0) {
    lines.push("", "**Pending:**");
    for (const t of episode.tasksPending) {
      lines.push(`- ${t}`);
    }
  }

  if (episode.filesTouched.length > 0) {
    lines.push("", "**Files:**");
    for (const f of episode.filesTouched) {
      lines.push(`- ${f}`);
    }
  }

  return lines.join("\n");
}
