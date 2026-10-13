import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Media metadata alone is not an attachment; provider emitters need inline bytes. */
export function hasMediaPayload(
  block: unknown,
): block is Record<string, unknown> & { data: string } {
  return isRecord(block) && typeof block.data === "string" && block.data.trim().length > 0;
}

/** Image metadata alone is not an attachment; provider emitters need inline bytes. */
export function isImageWithMediaPayload<T>(block: T): block is T & { type: "image"; data: string } {
  return isRecord(block) && block.type === "image" && hasMediaPayload(block);
}
