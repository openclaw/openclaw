import { createCipheriv, createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "../../src/config/sessions/session-accessor.sqlite-owner.js";
import { recordSessionParticipantFromWorker } from "../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import { appendTranscriptEventsInTransaction } from "../../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { executeSqliteQuerySync } from "../../src/infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../src/state/openclaw-state-db.js";
import { userProfilesDb } from "../../src/state/user-profiles-internal.js";
import { ensureUserProfilesSchema } from "../../src/state/user-profiles-schema.js";

type TeamShapeSession = { sessionKey: string; sessionId: string };

export type TeamShapeSessionsOptions = {
  stateDir: string;
  sessions: number;
  retainedRuns: number;
  seed: number | string;
  now: number;
  /** Total message text bytes before transcript compression and envelope overhead. */
  transcriptBytes?: number;
};

const MESSAGE_BYTES = 64 * 1024;
const TRANSACTION_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const VISIBILITIES = ["shared", "read-only", "suggest", "draft"] as const;
export const TEAM_SHAPE_RUN_SLOT_MS = 3 * 60_000;

export function teamShapeRootSessionCount(sessions: number): number {
  return Math.max(1, Math.ceil(sessions / 5));
}

/** Offline fixture writer: the caller owns an empty, isolated state directory and closes it. */
export async function seedTeamShapeSessions(options: TeamShapeSessionsOptions) {
  const started = performance.now();
  const transcriptBytes = options.transcriptBytes ?? 64 * 1024 * 1024;
  for (const [label, value] of Object.entries({
    sessions: options.sessions,
    retainedRuns: options.retainedRuns,
    transcriptBytes,
    now: options.now,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a nonnegative safe integer`);
    }
  }
  if (options.sessions === 0 && transcriptBytes !== 0) {
    throw new Error("transcriptBytes requires at least one session");
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: options.stateDir };
  const databaseOptions = { agentId: "main", env };
  ensureUserProfilesSchema({ env });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Fixed fixture identities keep owner/participant lookups populated and reproducible.
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .insertInto("user_profiles")
          .values(
            Array.from({ length: 24 }, (_, index) => ({
              id: `team-shape-profile-${index}`,
              display_name: `Synthetic teammate ${index}`,
              avatar: null,
              avatar_mime: null,
              avatar_sha256: null,
              merged_into: null,
              created_at: options.now,
              updated_at: options.now,
            })),
          ),
      );
    },
    { env },
  );
  const digest = createHash("sha256").update(String(options.seed)).digest();
  let randomState = digest.readUInt32LE(0);
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  // Repeated padding compresses to almost nothing. A deterministic stream keeps large fixtures real.
  const content = createCipheriv("aes-256-ctr", digest, Buffer.alloc(16));
  const zeros = Buffer.alloc(Math.ceil((MESSAGE_BYTES * 3) / 4));
  const sessions: TeamShapeSession[] = [];
  const weights: number[] = [];
  const timestamps: number[] = [];
  const visibilityCounts = { shared: 0, "read-only": 0, suggest: 0, draft: 0 };
  let participantCount = 0;
  let ownerCount = 0;
  let archivedCount = 0;
  let totalWeight = 0;
  const rootCount = teamShapeRootSessionCount(options.sessions);
  const latestCreation =
    options.retainedRuns > 0
      ? options.now - 60_000 - options.retainedRuns * TEAM_SHAPE_RUN_SLOT_MS
      : options.now;
  for (let offset = 0; offset < options.sessions; offset += 100) {
    runOpenClawAgentWriteTransaction((database) => {
      for (let index = offset; index < Math.min(offset + 100, options.sessions); index++) {
        const sessionId = `team-shape-session-${index}`;
        const sessionKey = `agent:main:${sessionId}`;
        const updatedAt = options.now - Math.floor(random() ** 2 * 30 * DAY_MS);
        const createdAt = Math.min(updatedAt - Math.floor(random() * 7 * DAY_MS), latestCreation);
        const profileId = `team-shape-profile-${index % 24}`;
        const visibility = VISIBILITIES[index % 10 < 7 ? 0 : (index % 10) - 6]!;
        const archived = index % 5 === 0;
        const isChild = index >= rootCount && index < rootCount + options.retainedRuns;
        const entry: InternalSessionEntry = {
          sessionId,
          updatedAt,
          createdAt,
          sessionStartedAt: createdAt,
          lastInteractionAt: updatedAt,
          lastActivityAt: updatedAt,
          lifecycleRevision: `team-shape-${index}`,
          label: `Synthetic ${["investigation", "implementation", "review", "planning"][index % 4]} ${index}`,
          displayName: `Team fixture session ${index}`,
          createdVia: isChild ? "spawn" : "operator",
          createdActor: isChild
            ? { type: "agent", id: "main" }
            : { type: "human", source: "profile", id: profileId },
          visibility,
          status: index % 13 === 0 ? "failed" : "done",
          ...(archived ? { archivedAt: updatedAt } : {}),
          ...(index % 31 === 0 ? { pinnedAt: updatedAt } : {}),
        };
        writeSessionEntry(database, sessionKey, entry);
        replaceSessionOwnerInTransaction(database, sessionKey, {
          actor: { type: "human", id: profileId },
          assignedBy: { type: "human", id: `team-shape-profile-${(index + 1) % 24}` },
          assignedAt: createdAt,
        });
        ownerCount++;
        const scope = { ...databaseOptions, sessionKey, sessionId };
        for (let participant = 0; participant < 1 + (index % 5); participant++) {
          recordSessionParticipantFromWorker(database, scope, {
            identity: { type: "profile", id: `team-shape-profile-${(index + participant) % 24}` },
            promptedAt: createdAt + participant,
            sessionAgentId: "main",
          });
          participantCount++;
        }
        sessions.push({ sessionKey, sessionId });
        timestamps.push(updatedAt);
        visibilityCounts[visibility]++;
        archivedCount += Number(archived);
        // Most sessions are short; a small retained tail owns most transcript bytes.
        const bucket = random();
        const weight = bucket < 0.8 ? 1 : bucket < 0.97 ? 16 : 128;
        weights.push(weight);
        totalWeight += weight;
      }
    }, databaseOptions);
    await yieldTurn();
  }
  let logicalTranscriptBytes = 0;
  let transcriptMessages = 0;
  let cumulativeWeight = 0;
  for (const [index, session] of sessions.entries()) {
    cumulativeWeight += weights[index]!;
    const target = Math.floor((cumulativeWeight / totalWeight) * transcriptBytes);
    let remaining = target - logicalTranscriptBytes;
    let messageIndex = 0;
    let parentId: string | null = null;
    let events: TranscriptEvent[] = [
      {
        type: "session",
        version: 3,
        id: session.sessionId,
        timestamp: new Date(timestamps[index]!).toISOString(),
      },
    ];
    let batchBytes = 0;
    const flush = () => {
      runOpenClawAgentWriteTransaction(
        (database) =>
          appendTranscriptEventsInTransaction(database, { ...databaseOptions, ...session }, events),
        databaseOptions,
      );
      events = [];
      batchBytes = 0;
    };
    while (remaining > 0) {
      const bytes = Math.min(MESSAGE_BYTES, remaining);
      const text = content
        .update(zeros.subarray(0, Math.ceil((bytes * 3) / 4)))
        .toString("base64")
        .slice(0, bytes);
      const id = `team-shape-message-${index}-${messageIndex}`;
      events.push({
        type: "message",
        id,
        parentId,
        timestamp: new Date(timestamps[index]!).toISOString(),
        message: {
          role: messageIndex % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text }],
          timestamp: timestamps[index]!,
        },
      });
      parentId = id;
      messageIndex++;
      transcriptMessages++;
      logicalTranscriptBytes += bytes;
      remaining -= bytes;
      batchBytes += bytes;
      if (batchBytes >= TRANSACTION_BYTES) {
        flush();
        await yieldTurn();
      }
    }
    if (events.length > 0) {
      flush();
    }
    if (index % 100 === 0) {
      await yieldTurn();
    }
  }
  content.final();
  return {
    sessions,
    logicalTranscriptBytes,
    transcriptMessages,
    visibilityCounts,
    ownerCount,
    participantCount,
    archivedCount,
    generationMs: performance.now() - started,
  };
}
