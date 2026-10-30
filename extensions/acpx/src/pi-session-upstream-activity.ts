import process from "node:process";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  SessionCatalogContinueProviderResult,
  SessionUpstreamActivity,
  SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { readSessionCatalogJsonlActivity } from "openclaw/plugin-sdk/session-catalog-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { piMessageText, readPiSessionFileBaseline } from "./pi-session-store.js";

function readFilePath(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.filePath === "string"
    ? probe.upstreamRef.filePath
    : undefined;
}

function readMarkerOffset(probe: SessionUpstreamProbe): number | undefined {
  return isRecord(probe.marker) &&
    Number.isSafeInteger(probe.marker.offset) &&
    Number(probe.marker.offset) >= 0
    ? Number(probe.marker.offset)
    : undefined;
}

export async function linkContinuedPiSession(
  sessionKey: string,
  threadId: string,
): Promise<SessionCatalogContinueProviderResult> {
  try {
    const baseline = await readPiSessionFileBaseline(threadId, process.env);
    // Legacy Pi versions rewrite during first resume, so the store helper declines
    // those links. Current v3 sessions persist by appending to this exact file.
    return baseline
      ? {
          sessionKey,
          upstream: {
            kind: "pi-cli",
            ref: { filePath: baseline.filePath },
            marker: { offset: baseline.offset },
          },
        }
      : { sessionKey };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

async function checkPiSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
): Promise<SessionUpstreamActivity | undefined> {
  if (probe.hostId !== "gateway" || probe.upstreamKind !== "pi-cli") {
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
    classifyLine(line) {
      const entry = safeParseJson<unknown>(line);
      if (!isRecord(entry)) {
        return false;
      }
      if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") {
        return undefined;
      }
      return {
        userText: piMessageText(entry.message.content),
        occurredAt:
          parseDateFirstTimestampMs(entry.message.timestamp) ??
          parseDateFirstTimestampMs(entry.timestamp),
      };
    },
  });
}

export async function checkPiUpstreamActivity(
  probes: SessionUpstreamProbe[],
): Promise<SessionUpstreamActivity[]> {
  const outcomes: SessionUpstreamActivity[] = [];
  for (const probe of probes) {
    try {
      const outcome = await checkPiSessionUpstreamActivity(probe);
      if (outcome) {
        outcomes.push(outcome);
      }
    } catch {
      // One transient file read must not suppress healthy sessions in the batch.
    }
  }
  return outcomes;
}
