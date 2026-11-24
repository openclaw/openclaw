import { createHash } from "node:crypto";
import { posix } from "node:path";
import { buildControlUiCatalogSharePath } from "openclaw/plugin-sdk/session-catalog-runtime";
import { BEAM_SESSION_SHARE_ROUTE, type BeamHandoff, type BeamStoredSession } from "./types.js";

export const BEAM_V2_API = "/api/v2/beam";

/** The second segment identifies a Beam publication independently of its destination chat. */
export function parsePublicationId(
  value: string,
): { beamId: string; publicationGeneration: string } | undefined {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(value);
  return match ? { beamId: match[1]!, publicationGeneration: match[2]! } : undefined;
}

/** V1 control fields and host identities never enter a portable representation. */
export function snapshotBytes(row: BeamStoredSession): string {
  return JSON.stringify({
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
    items: row.items.map(({ type, text }) => ({ type, text })),
  });
}

export function packetDigest(entity: string): string {
  return `sha256:${createHash("sha256").update(entity).digest("hex")}`;
}

export function publicationHead(
  row: BeamHandoff,
  digest: string,
  basePath: string | undefined,
  requestPath: string,
) {
  const publicationId = row.publicationId ? `${row.beamId}.${row.publicationId}` : undefined;
  // Existing rows have no revision until their next accepted write. The tag still
  // names their exact representation and, where available, their original generation.
  const revision = `"${
    row.revision ??
    createHash("sha256")
      .update(row.publicationId ?? "legacy")
      .update(digest)
      .digest("hex")
  }"`;
  const view = buildControlUiCatalogSharePath({
    shareRoute: BEAM_SESSION_SHARE_ROUTE,
    threadId: row.beamId,
    displayName: row.title,
    basePath,
  });
  // A reverse proxy can strip the external mount before forwarding a request.
  // Relative links resolve on the caller's actual URL without reading forwarding headers.
  const reference = (path: string) => posix.relative(posix.dirname(requestPath), path);
  return {
    beamId: row.beamId,
    revision,
    digest,
    ...(view ? { url: reference(view) } : {}),
    canRelease: false,
    ...(publicationId
      ? {
          publicationId,
          apiUrl: reference(`${BEAM_V2_API}/publications/${publicationId}`),
          state: row.handoffId ? "released" : "writable",
        }
      : {
          snapshotUrl: reference(`${BEAM_V2_API}/snapshots/${row.beamId}/snapshot`),
          state: "legacy_unbound",
        }),
  };
}
