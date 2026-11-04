import { randomUUID } from "node:crypto";
import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  BEAM_MAX_GUEST_SESSIONS,
  BEAM_MAX_SESSIONS,
  type BeamStoredSession,
  type BeamUpload,
} from "./src/types.js";

export type BeamPublisher =
  | { kind: "staff"; profileId?: string }
  | { kind: "guest"; profileId: string };

export type BeamUploadResult =
  | "applied"
  | "unchanged"
  | "forbidden"
  | "publisher-full"
  | "catalog-full";
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
      completeId?: string;
      action?: "begin" | "complete" | "rollback";
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
    const { beamId, agentId, publisherProfileId, createdAt } = command.input;
    const row = tx.entries<BeamStoredSession>(0).find((entry) => entry.key === beamId);
    if (
      !row ||
      row.value.publisherProfileId !== publisherProfileId ||
      row.value.createdAt !== createdAt
    ) {
      throw new Error("Beam publication changed before continuation; reopen its link");
    }
    if (row.value.continuation && !command.input.completeId) {
      return { session: row.value, reservedNow: false };
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
    const id = randomUUID();
    const session = {
      ...row.value,
      continuation: command.input.completeId
        ? command.input.action === "begin"
          ? { ...binding!, creating: true as const }
          : command.input.action === "rollback"
            ? { id: binding!.id, agentId: binding!.agentId, sessionKey: binding!.sessionKey }
            : { ...binding!, ready: true as const }
        : { id, agentId, sessionKey: `agent:${agentId}:dashboard:${id}` },
    };
    // Binding is metadata, not a new upload: preserve the publication's actual expiry.
    tx.set(
      0,
      beamId,
      session,
      row.expiresAt === undefined ? undefined : { ttlMs: Math.max(1, row.expiresAt - Date.now()) },
    );
    return { session, reservedNow: true };
  }
  const { upload, receivedAt, publisher } = command.input;
  const [existing] = tx.lookupMany<BeamStoredSession>([{ store: 0, key: upload.beamId }]);
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
  if (existing) {
    const incoming = beamTimestampEpochNanoseconds(upload.updatedAt);
    const current = beamTimestampEpochNanoseconds(existing.updatedAt);
    // Completion is monotonic within one source revision; a newer revision may reopen it.
    if (incoming < current || (incoming === current && existing.completed && !upload.completed)) {
      return "unchanged";
    }
  }
  const publisherProfileId = existing ? existing.publisherProfileId : publisher.profileId;
  tx.set(0, upload.beamId, {
    ...upload,
    ...(existing?.continuation ? { continuation: existing.continuation } : {}),
    ...(publisherProfileId ? { publisherProfileId } : {}),
    // Attribution describes this accepted upload, independently of the immutable initial owner.
    ...(publisher.profileId ? { uploaderProfileId: publisher.profileId } : {}),
    createdAt: existing?.createdAt ?? receivedAt,
    receivedAt,
  } satisfies BeamStoredSession);
  return "applied";
};
