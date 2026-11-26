import { posix } from "node:path";
import { buildControlUiCatalogSharePath } from "openclaw/plugin-sdk/session-catalog-runtime";
import { snapshotRevision } from "./packet-state.js";
import { BEAM_SESSION_SHARE_ROUTE, type BeamStoredSession } from "./types.js";

export const BEAM_V2_API = "/api/v2/beam";

/** The second segment identifies a Beam publication independently of its destination chat. */
export function parsePublicationId(
  value: string,
): { beamId: string; publicationGeneration: string } | undefined {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(value);
  return match ? { beamId: match[1]!, publicationGeneration: match[2]! } : undefined;
}

export function publicationHead(
  row: Pick<
    BeamStoredSession,
    | "presentationDigest"
    | "beamId"
    | "title"
    | "revision"
    | "publicationId"
    | "handoffId"
    | "publisherProfileId"
  >,
  digest: string,
  basePath: string | undefined,
  requestPath: string,
  publisherProfileId?: string,
) {
  const publicationId = row.publicationId ? `${row.beamId}.${row.publicationId}` : undefined;
  const revision = snapshotRevision(row, digest);
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
    ...(row.presentationDigest ? { presentationDigest: row.presentationDigest } : {}),
    ...(view ? { url: reference(view) } : {}),
    canRelease: Boolean(
      publicationId &&
      !row.handoffId &&
      publisherProfileId &&
      row.publisherProfileId === publisherProfileId,
    ),
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
