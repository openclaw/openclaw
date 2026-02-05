import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryArtifactsConfig } from "../config/types.memory.js";
import { listArtifactsForSession } from "./artifact-registry.js";

const DEFAULT_ARTIFACT_RECALL: Required<MemoryArtifactsConfig> = {
  enabled: true,
  maxItems: 8,
  maxChars: 2000,
  narrativeMaxChars: 600,
};

function resolveConfig(cfg?: MemoryArtifactsConfig): Required<MemoryArtifactsConfig> {
  return {
    enabled: cfg?.enabled ?? DEFAULT_ARTIFACT_RECALL.enabled,
    maxItems: cfg?.maxItems ?? DEFAULT_ARTIFACT_RECALL.maxItems,
    maxChars: cfg?.maxChars ?? DEFAULT_ARTIFACT_RECALL.maxChars,
    narrativeMaxChars: cfg?.narrativeMaxChars ?? DEFAULT_ARTIFACT_RECALL.narrativeMaxChars,
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildNarrative(summaries: string[], maxChars: number): string | null {
  if (summaries.length === 0) {
    return null;
  }
  const sentence = `I recently used tools that produced: ${summaries.join("; ")}.`;
  return truncateText(sentence, maxChars);
}

function buildListLinesWithinBudget(lines: string[], maxChars: number): string[] {
  if (maxChars <= 0) {
    return [];
  }
  const selected: string[] = [];
  for (const line of lines) {
    const separator = selected.length === 0 ? "" : "\n";
    const candidate = `${selected.join("\n")}${separator}${line}`;
    if (candidate.length <= maxChars) {
      selected.push(line);
      continue;
    }
    const ellipsis = "- …";
    const withEllipsis = `${selected.join("\n")}${separator}${ellipsis}`;
    if (selected.length === 0 && ellipsis.length <= maxChars) {
      selected.push(ellipsis);
    } else if (withEllipsis.length <= maxChars) {
      selected.push(ellipsis);
    }
    break;
  }
  return selected;
}

export function buildArtifactRecallSection(params: {
  sessionFile?: string | null;
  sessionKey?: string;
  config?: OpenClawConfig;
}): string | null {
  if (!params.sessionFile || !params.sessionKey) {
    return null;
  }
  const cfg = resolveConfig(params.config?.memory?.artifacts);
  if (!cfg.enabled) {
    return null;
  }
  const artifactDir = path.join(path.dirname(params.sessionFile), "artifacts");
  const entries = listArtifactsForSession({ artifactDir, sessionKey: params.sessionKey });
  if (entries.length === 0) {
    return null;
  }
  const recent = entries.slice(-cfg.maxItems);
  const summaries = recent.map((entry) => entry.artifact.summary).filter(Boolean);
  const narrative = buildNarrative(summaries, cfg.narrativeMaxChars);

  const lineCandidates: string[] = [];
  for (const entry of recent) {
    const summary = entry.artifact.summary || "artifact";
    const line = `- ${summary} (artifact: ${entry.artifact.id}, path: ${entry.artifact.path})`;
    lineCandidates.push(line);
  }

  const header = [
    "## Artifact Recall",
    "These artifacts are referenced for exact recall. Use the artifact id/path when needed.",
    "",
    "### Recall Strategy",
    "- Exact: read the artifact file by path when you need verbatim output.",
    "- Semantic: use memory_search for related context.",
  ];

  const headerText = header.join("\n");
  let available = cfg.maxChars - headerText.length;
  let narrativeBlock = "";

  if (narrative) {
    const block = `\n\n### Narrative\n${narrative}`;
    if (available - block.length >= 0) {
      narrativeBlock = block;
      available -= block.length;
    }
  }

  let listBlock = "";
  if (lineCandidates.length > 0 && available > 0) {
    const listHeader = "\n\n### Recent Artifacts\n";
    const listBudget = available - listHeader.length;
    if (listBudget > 0) {
      const lines = buildListLinesWithinBudget(lineCandidates, listBudget);
      if (lines.length > 0) {
        listBlock = `${listHeader}${lines.join("\n")}`;
      }
    }
  }

  const section = `${headerText}${narrativeBlock}${listBlock}`;
  return truncateText(section, cfg.maxChars);
}
