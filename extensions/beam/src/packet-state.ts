import { createHash } from "node:crypto";
import type { BeamHandoff, BeamStoredSession } from "./types.js";

/** V1 control fields and host identities never enter a portable representation. */
export function snapshotBytes(
  row: Pick<
    BeamStoredSession,
    | "beamId"
    | "source"
    | "title"
    | "updatedAt"
    | "completed"
    | "truncated"
    | "sourceModel"
    | "items"
    | "packetText"
  >,
): string {
  return (
    row.packetText ??
    JSON.stringify({
      version: 2,
      beamId: row.beamId,
      source: row.source,
      title: row.title,
      updatedAt: row.updatedAt,
      completed: row.completed,
      ...(row.truncated ? { truncated: true } : {}),
      ...(row.sourceModel
        ? { sourceModel: { provider: row.sourceModel.provider, model: row.sourceModel.model } }
        : {}),
      items: row.items.map(({ type, text, speaker }) => ({
        type,
        text,
        ...(speaker ? { speaker } : {}),
      })),
    })
  );
}

export function packetDigest(entity: string): string {
  return `sha256:${createHash("sha256").update(entity).digest("hex")}`;
}

export function snapshotRevision(
  row: Pick<BeamHandoff, "revision" | "publicationId">,
  digest: string,
): string {
  // Existing rows have no revision until their next accepted write. The tag still
  // names their exact representation and, where available, their original generation.
  return `"${
    row.revision ??
    createHash("sha256")
      .update(row.publicationId ?? "legacy")
      .update(digest)
      .digest("hex")
  }"`;
}
