import { createHash } from "node:crypto";
import type { CatalogExportItem, SessionCatalogLocator } from "openclaw/plugin-sdk/session-catalog";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BeamCleanCandidate } from "./cleaner.js";
import type { BeamSourceModel } from "./types.js";

export function beamMirrorId(catalogId: string, hostId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${catalogId}\0${hostId}\0${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Reduce newest-first catalog items to chronological Beam uploads. Only user/agent
 * message text crosses the wire; reasoning, tool calls, tool results, and raw
 * payloads collapse into compact counts.
 */
export function buildBeamMirrorItems(items: readonly CatalogExportItem[]) {
  const out: BeamCleanCandidate["items"] = [];
  const dropped = new Map<string, number>();
  const speakers = new Map<string, string>();
  const truncated = items.some((item) => item.truncated);
  const flush = () => {
    if (dropped.size > 0) {
      const counts = [...dropped].map(([kind, count]) => `${count} ${kind}`).join(", ");
      out.push({ type: "other", text: `${counts}; raw content dropped` });
      dropped.clear();
    }
  };
  const labels: Partial<Record<CatalogExportItem["type"], string>> = {
    toolCall: "tool calls",
    toolResult: "tool results",
    reasoning: "reasoning items",
  };
  for (const item of items.toReversed()) {
    const text = item.text?.trim();
    if ((item.type === "userMessage" || item.type === "agentMessage") && text) {
      flush();
      // Grants rotate private speaker tokens. The cleaner needs only their equality
      // within this selection, including when it trims an older part of the history.
      let speakerId: string | undefined;
      if (item.type === "userMessage" && item.speakerId) {
        speakerId = speakers.get(item.speakerId) ?? String(speakers.size + 1);
        speakers.set(item.speakerId, speakerId);
      }
      out.push({ type: item.type, text, ...(speakerId ? { speakerId } : {}) });
      continue;
    }
    const label = labels[item.type] ?? "other entries";
    dropped.set(label, (dropped.get(label) ?? 0) + 1);
  }
  flush();
  return { items: out, truncated };
}

export type BeamMirrorCandidate = SessionCatalogLocator & {
  agentId: string;
  beamId: string;
  modelProvider?: string;
  title: string;
  recencyAt: number;
};

export function sourceModelForMirror(
  providerValue: string | undefined,
  items: readonly CatalogExportItem[],
): BeamSourceModel | undefined {
  const provider = providerValue?.trim().toLowerCase();
  const rawModel = items.find((item) => item.type === "agentMessage" && item.model?.trim())?.model;
  if (!provider || !/^[a-z0-9._-]+$/i.test(provider) || !rawModel) {
    return undefined;
  }
  const prefixed = rawModel.trim();
  const model = truncateUtf16Safe(
    prefixed.startsWith(`${provider}/`) ? prefixed.slice(provider.length + 1) : prefixed,
    256,
  ).trim();
  return model && /^\S+$/u.test(model) ? { provider, model } : undefined;
}

export function mirrorCandidateKey(candidate: BeamMirrorCandidate): string {
  return JSON.stringify([
    candidate.catalogId,
    candidate.hostId,
    candidate.threadId,
    candidate.agentId,
    candidate.sourceHomeId ?? null,
  ]);
}
