import { createHash } from "node:crypto";
import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";
import { packetDigest, snapshotBytes, snapshotRevision } from "./src/packet-state.js";
import {
  BEAM_MAX_GUEST_RECEIPTS,
  BEAM_RETENTION_MS,
  type BeamStoredSession,
  type BeamHandoff,
  type BeamUpload,
} from "./src/types.js";
import { persistBeamUpload, type BeamPublisher } from "./upload-operation-api.js";

export type BeamPublishInput = {
  upload: BeamUpload;
  packetText: string;
  digest: string;
  ifMatch: string | null;
  requestId: string;
  receivedAt: number;
  publisher: BeamPublisher;
};

export type BeamPublishHead = Pick<BeamStoredSession, "beamId" | "revision" | "title"> & {
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

export type BeamPublicationOperations = {
  publish: {
    input: BeamPublishInput;
    output:
      | BeamPublishHead
      | BeamWriteRefusal
      | { refusal: "receipt_capacity"; retryAfterSeconds: number };
  };
};

type PublishReceipt = { fingerprint: string; result: BeamPublishHead };

/** The receiver records acceptance and its receipt as one commit. A replay never
 * re-creates deleted content or refreshes the current publication's retention. */
export const executeBeamPublication: PluginStateOperationHandler<BeamPublicationOperations> = (
  command,
  tx,
) => {
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
  const fingerprint = JSON.stringify([ifMatch, digest]);
  const [prior] = tx.lookupMany<PublishReceipt>([{ store: 2, key: receiptKey }]);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      return "request_identity_conflict";
    }
    if (prior.result.publicationId !== existing?.publicationId) {
      return "unavailable";
    }
    return prior.result;
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
    ? (tx.lookupMany<number[]>([{ store: 2, key: guestKey }])[0] ?? []).filter(
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
  const unchanged = currentDigest === digest && row?.publicationId !== undefined;
  if (!unchanged) {
    const written = persistBeamUpload(input, tx, { packetText: input.packetText });
    if (written === "publisher-full" || written === "catalog-full") {
      return "rate_limited";
    }
    if (written === "forbidden") {
      return "unavailable";
    }
    if (typeof written !== "object" || written.kind !== "published") {
      return "released";
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
    digest,
    disposition: unchanged ? "unchanged" : "applied",
  };
  if (guestKey) {
    tx.set(2, guestKey, [...expiries, now + BEAM_RETENTION_MS]);
  }
  tx.set(2, receiptKey, {
    fingerprint,
    result,
  } satisfies PublishReceipt);
  return result;
};
