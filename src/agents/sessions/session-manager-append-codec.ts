import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  findSessionTranscriptHeader,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
} from "../../config/sessions/session-entry-codec.js";
import type { SessionMetadataOperations } from "../../config/sessions/session-manager-write-contract.js";
import type { SessionHeader, SessionEntry, SessionLeafControl } from "./session-manager-types.js";

export function decodeMetadataAppendEvent(
  input: SessionMetadataOperations["session.metadata.append"]["input"],
): SessionHeader | SessionEntry | SessionLeafControl {
  const event: unknown =
    typeof input.event === "string"
      ? JSON.parse(input.event)
      : { ...input.event, message: JSON.parse(input.message?.messageJson ?? "null") };
  if (isIndexedSessionEntry(event)) {
    if ((event.type === "message") !== (typeof input.event !== "string")) {
      throw new Error("Session message append requires prepared storage bytes");
    }
    return event;
  }
  const header = findSessionTranscriptHeader([event]);
  if (header) {
    return header;
  }
  const leaf = parseOpaqueLeafEntry(event);
  if (leaf && isRecord(event) && typeof event.timestamp === "string") {
    return { ...leaf, type: "leaf", timestamp: event.timestamp };
  }
  throw new Error("Invalid serialized session transcript entry");
}

/** Reload decisions retain the canonical adopted identity and actual append parent. */
export function sessionMetadataAppendNeedsReload(
  input: SessionMetadataOperations["session.metadata.append"]["input"],
  value: SessionMetadataOperations["session.metadata.append"]["output"],
): boolean {
  const event = decodeMetadataAppendEvent(input);
  if (event.type === "session" || !input.view || !value.snapshot.ok) {
    return false;
  }
  const committed = value.snapshot.value;
  const result = committed.result;
  if (!result) {
    return false;
  }
  const adoptedMessage = "messageId" in result && result.messageId !== event.id;
  if (!result.appended && !adoptedMessage) {
    return false;
  }
  const version = input.view.loadedVersion;
  const parent = "effectiveParentId" in result ? result.effectiveParentId : undefined;
  return (
    adoptedMessage ||
    Boolean(
      version &&
      (committed.before.generation !== version.generation ||
        committed.before.rawSeq !== version.rawSeq),
    ) ||
    (parent !== undefined && parent !== event.parentId)
  );
}
