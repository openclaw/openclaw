import { randomUUID } from "node:crypto";
import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  BEAM_MAX_GUEST_SESSIONS,
  BEAM_MAX_SESSIONS,
  type BeamStoredSession,
  type BeamHandoff,
  type BeamUpload,
} from "./src/types.js";

export type BeamPublisher =
  | { kind: "staff"; profileId?: string }
  | { kind: "guest"; profileId: string };

export type BeamUploadResult =
  | { kind: "published"; id?: string; applied: boolean }
  | "forbidden"
  | "publisher-full"
  | "catalog-full"
  | "handoff-conflict"
  | { kind: "handoff"; id: string; accepted: boolean };
export type BeamUploadOperations = {
  upload: {
    input: { upload: BeamUpload; receivedAt: number; publisher: BeamPublisher };
    output: BeamUploadResult;
  };
  reserveContinuation: {
    input: {
      beamId: string;
      agentId: string;
      publisherProfileId?: string;
      createdAt: number;
      handoffId: string;
      completeId?: string;
      action?: "begin" | "complete" | "rollback";
      creationId?: string;
    };
    output: { session: BeamStoredSession; reservedNow: boolean };
  };
};

function beamTimestampEpochNanoseconds(value: string): bigint {
  const match = /\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}$)/.exec(value);
  const fraction = (match?.[1] ?? "").padEnd(9, "0");
  // Date.parse drops accepted fractional precision after milliseconds.
  const millisecondTimestamp = match
    ? `${value.slice(0, match.index)}.${fraction.slice(0, 3)}${value.slice(match.index + match[0].length)}`
    : value;
  return BigInt(Date.parse(millisecondTimestamp)) * 1_000_000n + BigInt(fraction.slice(3));
}

export const executeBeamUpload: PluginStateOperationHandler<BeamUploadOperations> = (
  command,
  tx,
) => {
  if (command.type === "reserveContinuation") {
    const { beamId, agentId, publisherProfileId, createdAt, handoffId } = command.input;
    const [value] = tx.lookupMany<BeamHandoff>([{ store: 1, key: beamId }]);
    const snapshot = tx.entries<BeamStoredSession>(0).find((entry) => entry.key === beamId);
    const row = value ? { value: { ...value, items: snapshot?.value.items ?? [] } } : undefined;
    if (
      !row ||
      row.value.publisherProfileId !== publisherProfileId ||
      row.value.createdAt !== createdAt ||
      row.value.handoffId !== handoffId
    ) {
      throw new Error("Beam publication changed before continuation; reopen its link");
    }
    if (!row.value.handoffId) {
      throw new Error(
        "The source still owns this Beam. Use the updated Beam client's handoff command before continuing.",
      );
    }
    if (row.value.continuation && !command.input.completeId) {
      return { session: row.value, reservedNow: false };
    }
    if (
      !snapshot &&
      !row.value.continuation?.ready &&
      (!command.input.action || command.input.action === "begin")
    ) {
      throw new Error(
        "The handoff snapshot expired before destination creation; no new conversation was created",
      );
    }
    if (command.input.completeId && row.value.continuation?.id !== command.input.completeId) {
      throw new Error("Beam handoff changed before completion");
    }
    const binding = row.value.continuation;
    if (command.input.action === "begin" && (binding?.creating || binding?.ready)) {
      return { session: row.value, reservedNow: false };
    }
    if (command.input.action === "rollback" && binding?.ready) {
      throw new Error("A completed conversation cannot be recreated");
    }
    const { action, creationId } = command.input;
    if (action && (!creationId || (action !== "begin" && binding?.creating !== creationId))) {
      throw new Error("Beam creation attempt changed before settlement");
    }
    const id = randomUUID();
    const session = {
      ...row.value,
      continuation: command.input.completeId
        ? command.input.action === "begin"
          ? { ...binding!, creating: creationId! }
          : command.input.action === "rollback"
            ? { id: binding!.id, agentId: binding!.agentId, sessionKey: binding!.sessionKey }
            : { ...binding!, ready: true as const }
        : { id, agentId, sessionKey: `agent:${agentId}:dashboard:${id}` },
    };
    // Binding is metadata, not a new upload: preserve the publication's actual expiry.
    const { items: _items, ...handoff } = session;
    tx.set(1, beamId, handoff);
    if (snapshot) {
      tx.set(
        0,
        beamId,
        session,
        snapshot.expiresAt === undefined
          ? undefined
          : { ttlMs: Math.max(1, snapshot.expiresAt - Date.now()) },
      );
    }
    return { session, reservedNow: true };
  }
  const { upload, receivedAt, publisher } = command.input;
  const [snapshot, handoff] = tx.lookupMany<BeamStoredSession | BeamHandoff>([
    { store: 0, key: upload.beamId },
    { store: 1, key: upload.beamId },
  ]);
  const existing = handoff ?? snapshot;
  if (
    upload.handoffId &&
    (!publisher.profileId || (existing && existing.publisherProfileId !== publisher.profileId))
  ) {
    return "forbidden";
  }
  if (publisher.kind === "guest") {
    // Ownerless retained rows predate ownership or were published anonymously; never claim them.
    if (existing && existing.publisherProfileId !== publisher.profileId) {
      return "forbidden";
    }
    if (!existing) {
      const entries = tx.entries<BeamStoredSession>(0);
      if (
        entries.filter(({ value }) => value.publisherProfileId === publisher.profileId).length >=
        BEAM_MAX_GUEST_SESSIONS
      ) {
        return "publisher-full";
      }
      // A guest cannot use the staff namespace's oldest-entry eviction to remove another snapshot.
      if (entries.length >= BEAM_MAX_SESSIONS) {
        return "catalog-full";
      }
    }
  }
  // Release is irreversible within this publication. Return the recorded owner
  // even to an old sender; neither a replay nor a fresh local turn may fork it.
  if (existing?.handoffId) {
    return {
      kind: "handoff",
      id: existing.handoffId,
      accepted: upload.handoffId === existing.handoffId,
    };
  }
  if (
    upload.handoffId &&
    (!existing || existing.publicationId !== upload.handoffId || existing.continuation)
  ) {
    return "handoff-conflict";
  }
  if (existing) {
    const incoming = beamTimestampEpochNanoseconds(upload.updatedAt);
    const current = beamTimestampEpochNanoseconds(existing.updatedAt);
    // Completion is monotonic within one source revision; a newer revision may reopen it.
    if (incoming < current || (incoming === current && existing.completed && !upload.completed)) {
      return upload.handoffId
        ? "handoff-conflict"
        : { kind: "published", id: existing.publicationId, applied: false };
    }
  }
  const publisherProfileId = existing ? existing.publisherProfileId : publisher.profileId;
  const publicationId = existing?.publicationId ?? randomUUID().replaceAll("-", "");
  const session = {
    ...upload,
    publicationId,
    ...(existing?.continuation ? { continuation: existing.continuation } : {}),
    ...(publisherProfileId ? { publisherProfileId } : {}),
    // Attribution describes this accepted upload, independently of the immutable initial owner.
    ...(publisher.profileId ? { uploaderProfileId: publisher.profileId } : {}),
    createdAt: existing?.createdAt ?? receivedAt,
    receivedAt,
  } satisfies BeamStoredSession;
  tx.set(0, upload.beamId, session);
  if (upload.handoffId) {
    // Archive/expiry removes the snapshot, never this logical identity's release.
    const { items: _items, ...ownership } = session;
    tx.set(1, upload.beamId, ownership);
  }
  return upload.handoffId
    ? { kind: "handoff", id: upload.handoffId, accepted: true }
    : { kind: "published", id: publicationId, applied: true };
};
