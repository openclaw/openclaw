import { createHash } from "node:crypto";
import type {
  PluginStateOperationHandler,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { packetDigest, snapshotBytes, snapshotRevision } from "./src/packet-state.js";
import type { BeamScreenshot } from "./src/screenshot.js";
import {
  BEAM_MAX_GUEST_RECEIPTS,
  BEAM_RETENTION_MS,
  type BeamStoredSession,
  type BeamHandoff,
  type BeamUpload,
} from "./src/types.js";
import { persistBeamUpload, type BeamPublisher } from "./upload-operation-api.js";

export type BeamPublishInput = {
  image?: BeamScreenshot;
  upload: BeamUpload;
  packetText: string;
  digest: string;
  ifMatch: string | null;
  requestId: string;
  receivedAt: number;
  publisher: BeamPublisher;
};

export type BeamPublishHead = Pick<
  BeamStoredSession,
  "beamId" | "revision" | "title" | "publisherProfileId" | "presentationDigest"
> & {
  publicationId: string;
  digest: string;
  disposition: "applied" | "unchanged";
};
export type BeamWriteRefusal =
  | "unavailable"
  | "revision_changed"
  | "request_identity_conflict"
  | "released"
  | "rate_limited";

export type BeamReleaseInput = {
  beamId: string;
  publicationGeneration: string;
  profileId: string;
  requestId: string;
  revision: string;
  digest: string;
};
export type BeamReleaseResult = Pick<
  BeamHandoff,
  "beamId" | "title" | "publicationId" | "revision" | "handoffId" | "publisherProfileId"
> & { digest: string };

export type BeamPublicationOperations = {
  archive: { input: { beamId: string }; output: boolean };
  publish: {
    input: BeamPublishInput;
    output:
      | BeamPublishHead
      | BeamWriteRefusal
      | { refusal: "receipt_capacity"; retryAfterSeconds: number };
  };
  release: { input: BeamReleaseInput; output: BeamReleaseResult | BeamWriteRefusal | "expired" };
};

type PublishReceipt = { fingerprint: string; result: BeamPublishHead };

/** The receiver records acceptance and its receipt as one commit. A replay never
 * re-creates deleted content or refreshes the current publication's retention. */
export const executeBeamPublication: PluginStateOperationHandler<BeamPublicationOperations> = (
  command,
  tx,
) => {
  if (command.type === "archive") {
    tx.delete(1, command.input.beamId);
    return tx.delete(0, command.input.beamId);
  }
  if (command.type === "release") {
    return releasePublication(command.input, tx);
  }
  const input = command.input;
  const { upload, requestId, publisher, ifMatch, digest } = input;
  const receiptKey = createHash("sha256")
    .update(JSON.stringify(["publish", upload.beamId, publisher.profileId ?? null, requestId]))
    .digest("hex");
  const [row] = tx.lookupMany<BeamStoredSession>([{ store: 0, key: upload.beamId }]);
  const [handoff] = tx.lookupMany<BeamHandoff>([{ store: 1, key: upload.beamId }]);
  const existing = handoff ?? row;
  if (
    publisher.kind === "guest" &&
    existing &&
    existing.publisherProfileId !== publisher.profileId
  ) {
    return "unavailable";
  }
  const fingerprint = JSON.stringify(
    input.image ? [ifMatch, digest, input.image.digest] : [ifMatch, digest],
  );
  const [prior] = tx.lookupMany<PublishReceipt>([{ store: 3, key: receiptKey }]);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      return "request_identity_conflict";
    }
    if (prior.result.publicationId !== existing?.publicationId) {
      return "unavailable";
    }
    return {
      ...prior.result,
      // The bytes and revision in the original receipt remain stable. A stale receipt
      // cannot advertise permission to release a newer revision or an already released row.
      publisherProfileId:
        !existing?.handoffId && existing?.revision === prior.result.revision
          ? existing?.publisherProfileId
          : undefined,
    };
  }
  if (handoff?.handoffId || row?.handoffId) {
    return "released";
  }
  const currentDigest = row && packetDigest(snapshotBytes(row));
  if (row ? ifMatch !== snapshotRevision(row, currentDigest!) : ifMatch !== null) {
    return "revision_changed";
  }
  // Replay consumes no extra slot. A restricted publisher cannot fill the shared receipt store
  // by repeatedly publishing one unchanged snapshot with new request IDs.
  const guestKey =
    publisher.kind === "guest"
      ? "guest:" + createHash("sha256").update(publisher.profileId).digest("hex")
      : undefined;
  const now = Date.now();
  const expiries = guestKey
    ? (tx.lookupMany<number[]>([{ store: 3, key: guestKey }])[0] ?? []).filter(
        (expiresAt) => expiresAt > now,
      )
    : [];
  if (guestKey && expiries.length >= BEAM_MAX_GUEST_RECEIPTS) {
    return {
      refusal: "receipt_capacity",
      retryAfterSeconds: Math.max(1, Math.ceil((Math.min(...expiries) - now) / 1000)),
    };
  }
  let current = row;
  const unchanged =
    currentDigest === digest &&
    row?.publicationId !== undefined &&
    input.image?.digest === row.presentationDigest;
  if (!unchanged) {
    const written = persistBeamUpload(input, tx, {
      packetText: input.packetText,
      presentationDigest: input.image?.digest,
    });
    if (written === "publisher-full" || written === "catalog-full") {
      return "rate_limited";
    }
    if (written === "forbidden") {
      return "unavailable";
    }
    if (typeof written !== "object" || written.kind !== "published") {
      return "released";
    }
    // Publish the media and its owning snapshot together. An unsuccessful write leaves neither visible.
    if (input.image) {
      tx.set(2, upload.beamId, input.image);
    } else if (row?.presentationDigest) {
      tx.delete(2, upload.beamId);
    }
    [current] = tx.lookupMany<BeamStoredSession>([{ store: 0, key: upload.beamId }]);
  }
  if (!current?.publicationId) {
    throw new Error("Beam publication was not recorded");
  }
  const result: BeamPublishHead = {
    beamId: upload.beamId,
    publicationId: current.publicationId,
    ...(current.revision ? { revision: current.revision } : {}),
    title: current.title,
    ...(current.presentationDigest ? { presentationDigest: current.presentationDigest } : {}),
    ...(current.publisherProfileId ? { publisherProfileId: current.publisherProfileId } : {}),
    digest,
    disposition: unchanged ? "unchanged" : "applied",
  };
  if (guestKey) {
    tx.set(3, guestKey, [...expiries, now + BEAM_RETENTION_MS]);
  }
  tx.set(3, receiptKey, {
    fingerprint,
    result,
  } satisfies PublishReceipt);
  return result;
};

function releasePublication(
  input: BeamReleaseInput,
  tx: PluginStateOperationTransaction,
): BeamPublicationOperations["release"]["output"] {
  const retained = tx.lookupMany<BeamHandoff>([{ store: 1, key: input.beamId }])[0];
  const current = tx.lookupMany<BeamStoredSession>([{ store: 0, key: input.beamId }])[0];
  const row = retained ?? current;
  if (
    !row ||
    row.publicationId !== input.publicationGeneration ||
    row.publisherProfileId !== input.profileId
  ) {
    return "unavailable";
  }
  const result = {
    beamId: row.beamId,
    title: row.title,
    publicationId: input.publicationGeneration,
    revision: row.revision,
    handoffId: input.publicationGeneration,
    digest: input.digest,
  };
  if (row.releaseReceipt?.requestId === input.requestId) {
    return row.releaseReceipt.revision === input.revision &&
      row.releaseReceipt.digest === input.digest
      ? result
      : "request_identity_conflict";
  }
  if (row.handoffId) {
    return "released";
  }
  if (!current) {
    return "expired";
  }
  const digest = packetDigest(snapshotBytes(current));
  if (input.digest !== digest || input.revision !== snapshotRevision(row, digest)) {
    return "revision_changed";
  }
  // The current transaction API exposes expiry only with entries(). Read that metadata
  // after keyed admission so a refused or replayed release never loads other transcripts.
  const snapshot = tx.entries<BeamStoredSession>(0).find((entry) => entry.key === input.beamId);
  if (!snapshot) {
    return "expired";
  }
  const released = {
    ...current,
    handoffId: input.publicationGeneration,
    releaseReceipt: { requestId: input.requestId, revision: input.revision, digest },
  };
  // Both API versions must see one release, but only the snapshot store retains transcript bytes.
  const { items: _items, packetText: _packet, presentationDigest: _image, ...ownership } = released;
  tx.set(1, input.beamId, ownership);
  tx.set(
    0,
    input.beamId,
    released,
    snapshot.expiresAt === undefined
      ? undefined
      : { ttlMs: Math.max(1, snapshot.expiresAt - Date.now()) },
  );
  return result;
}
