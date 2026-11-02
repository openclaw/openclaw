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
  { input: { upload, receivedAt, publisher } },
  tx,
) => {
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
    ...(publisherProfileId ? { publisherProfileId } : {}),
    // Attribution describes this accepted upload, independently of the immutable initial owner.
    ...(publisher.profileId ? { uploaderProfileId: publisher.profileId } : {}),
    createdAt: existing?.createdAt ?? receivedAt,
    receivedAt,
  } satisfies BeamStoredSession);
  return "applied";
};
