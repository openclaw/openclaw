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
      // V1 accepted unpaired UTF-16 surrogates from JSON escapes. Portable v2
      // requires Unicode scalars, including on reads of previously stored rows.
      title: row.title.toWellFormed(),
      updatedAt: row.updatedAt,
      completed: row.completed,
      ...(row.truncated ? { truncated: true } : {}),
      ...(row.sourceModel
        ? {
            sourceModel: {
              provider: row.sourceModel.provider,
              model: row.sourceModel.model.toWellFormed(),
            },
          }
        : {}),
      items: row.items.map(({ type, text, speaker }) => ({
        type,
        text: text.toWellFormed(),
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
  // A condition on one enrolled publication must never update another, even if a
  // restored receiver supplies identical packet bytes and the same stored write revision.
  const tag = createHash("sha256")
    .update(JSON.stringify([row.publicationId ?? null, row.revision ?? null, digest]))
    .digest("hex");
  return `"${tag}"`;
}
