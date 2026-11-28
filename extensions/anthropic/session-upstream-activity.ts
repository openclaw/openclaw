import fs from "node:fs/promises";
import {
  classifyClaudeCliHistoryMessage,
  classifyClaudeCliHistoryLine,
  isExternalUserText,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { readSessionCatalogJsonlActivity } from "openclaw/plugin-sdk/session-catalog-runtime";
import { asSafeIntegerInRange, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

export async function linkContinued(params: {
  sessionKey: string;
  hostId: string;
  threadId: string;
  history?: ClaudeTranscriptItem[];
  listLocalSessions: () => Promise<Array<{ threadId: string; filePath: string }>>;
  readRemote: () => Promise<ClaudeTranscriptItem[]>;
}): Promise<SessionCatalogContinueProviderResult> {
  const { sessionKey, hostId, threadId } = params;
  try {
    if (hostId === "gateway:local") {
      const record = (await params.listLocalSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      const stat = record ? await fs.stat(record.filePath).catch(() => undefined) : undefined;
      return record && stat?.isFile()
        ? {
            sessionKey,
            upstream: {
              kind: "claude-cli",
              ref: { filePath: record.filePath },
              marker: { offset: stat.size },
            },
          }
        : { sessionKey };
    }
    if (!hostId.startsWith("node:")) {
      return { sessionKey };
    }
    const items = params.history ?? (await params.readRemote());
    const newest = items[0];
    // A UUID-less newest item cannot anchor a baseline distinguishable from an empty
    // thread, which would later replay pre-adoption history as new activity. Decline
    // the link; empty history (no newest) still baselines safely as null.
    if (newest && !newest.uuid) {
      return { sessionKey };
    }
    return {
      sessionKey,
      upstream: {
        kind: "claude-cli",
        ref: { nodeId: hostId.slice("node:".length), threadId },
        marker: { uuid: newest?.uuid ?? null },
      },
    };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

function readFilePath(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.filePath === "string"
    ? probe.upstreamRef.filePath
    : undefined;
}

function readMarkerOffset(probe: SessionUpstreamProbe): number | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  const offset = probe.marker.offset ?? probe.marker.size;
  return asSafeIntegerInRange(offset, { min: 0 });
}

async function checkClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
): Promise<SessionUpstreamActivity | undefined> {
  if (probe.upstreamKind !== "claude-cli") {
    return undefined;
  }
  const filePath = readFilePath(probe);
  const markerOffset = readMarkerOffset(probe);
  if (!filePath || markerOffset === undefined) {
    return undefined;
  }
  return readSessionCatalogJsonlActivity({
    probe,
    filePath,
    offset: markerOffset,
    classifyLine(line, sourceLineNumber) {
      const classification = classifyClaudeCliHistoryLine({
        line,
        cliSessionId: probe.threadId,
        sourceLineNumber,
      });
      return classification.humanTurn ? classification : undefined;
    },
  });
}

function readMarkerUuid(probe: SessionUpstreamProbe): string | null | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  return probe.marker.uuid === null || typeof probe.marker.uuid === "string"
    ? probe.marker.uuid
    : undefined;
}

async function checkRemoteClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
  readRemote: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity | undefined> {
  if (
    !isRecord(probe.upstreamRef) ||
    typeof probe.upstreamRef.nodeId !== "string" ||
    probe.hostId !== `node:${probe.upstreamRef.nodeId}`
  ) {
    return undefined;
  }
  const markerUuid = readMarkerUuid(probe);
  if (markerUuid === undefined) {
    return undefined;
  }
  const items = await readRemote(probe);
  const markerIndex =
    markerUuid === null ? -1 : items.findIndex((item) => item.uuid === markerUuid);
  const newItems = markerIndex < 0 ? items : items.slice(0, markerIndex);
  const newest = newItems[0];
  if (!newest?.uuid) {
    return undefined;
  }
  let humanTurns = 0;
  let occurredAt: number | undefined;
  for (const [itemIndex, item] of newItems.entries()) {
    if (item.type !== "userMessage") {
      continue;
    }
    const classification = classifyClaudeCliHistoryMessage({
      content: item.content ?? item.text,
      timestamp: item.timestamp,
      cliSessionId: probe.threadId,
      sourceLineNumber: itemIndex + 1,
    });
    if (!classification.humanTurn || !isExternalUserText(probe, classification.userText)) {
      continue;
    }
    humanTurns += 1;
    occurredAt = Math.max(occurredAt ?? 0, classification.occurredAt ?? Date.now());
  }
  const activityId = newest.uuid;
  return {
    kind: "activity",
    sessionKey: probe.sessionKey,
    humanTurns,
    nextMarker: { uuid: activityId },
    ...(humanTurns > 0 ? { occurredAt: occurredAt ?? Date.now(), dedupeId: activityId } : {}),
  };
}

export async function checkClaudeUpstreamActivity(
  probes: SessionUpstreamProbe[],
  readRemote?: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity[]> {
  const activities: SessionUpstreamActivity[] = [];
  for (const probe of probes) {
    try {
      const activity = readFilePath(probe)
        ? await checkClaudeSessionUpstreamActivity(probe)
        : readRemote
          ? await checkRemoteClaudeSessionUpstreamActivity(probe, readRemote)
          : undefined;
      if (activity) {
        activities.push(activity);
      }
    } catch {
      // One missing transcript must not suppress healthy sessions in the provider batch.
    }
  }
  return activities;
}
