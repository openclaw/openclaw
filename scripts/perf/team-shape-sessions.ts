import { createCipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "../../src/config/sessions/session-accessor.sqlite-owner.js";
import { recordSessionParticipantFromWorker } from "../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import { appendTranscriptEventsInTransaction } from "../../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { mutatePendingInput } from "../../src/config/sessions/session-pending-input-operations.kernel.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { executeSqliteQuerySync } from "../../src/infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
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
  longTranscriptEntries?: number;
  longTranscriptSessions?: number;
  chatStartupSessions?: number;
  /** Stable category mix for the reusable dev-Gateway load harness. */
  teamStress?: boolean;
};

const MESSAGE_BYTES = 64 * 1024;
const TRANSACTION_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const VISIBILITIES = ["shared", "read-only", "suggest", "draft"] as const;
export const TEAM_SHAPE_RUN_SLOT_MS = 3 * 60_000;

export function teamShapeRootSessionCount(sessions: number): number {
  return Math.max(1, Math.ceil(sessions / 5));
}

/** Sequential fixture writes share a filesystem with production on the benchmark host. */
export async function waitForTeamShapeWriteBudget() {
  if (process.platform !== "linux") {
    return;
  }
  for (;;) {
    const dirtyKb = Number(/^Dirty:\s+(\d+)/m.exec(await readFile("/proc/meminfo", "utf8"))?.[1]);
    if (!Number.isFinite(dirtyKb) || dirtyKb >= 2 * 1024 * 1024) {
      throw new Error("Fixture stopped: Linux Dirty memory is unavailable or reached 2 GiB");
    }
    if (dirtyKb < 1024 * 1024) {
      return;
    }
    await delay(1_000);
  }
}

/** Offline fixture writer: the caller owns an empty, isolated state directory and closes it. */
export async function seedTeamShapeSessions(options: TeamShapeSessionsOptions) {
  const started = performance.now();
  const transcriptBytes = options.transcriptBytes ?? 64 * 1024 * 1024;
  const longTranscriptEntries = options.longTranscriptEntries ?? 0;
  const longTranscriptSessions = Math.min(options.longTranscriptSessions ?? 4, options.sessions);
  const chatStartupSessions = options.chatStartupSessions ?? 0;
  for (const [label, value] of Object.entries({
    sessions: options.sessions,
    retainedRuns: options.retainedRuns,
    transcriptBytes,
    longTranscriptEntries,
    longTranscriptSessions,
    chatStartupSessions,
    now: options.now,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a nonnegative safe integer`);
    }
  }
  if (options.sessions === 0 && transcriptBytes !== 0) {
    throw new Error("transcriptBytes requires at least one session");
  }
  if (chatStartupSessions > options.sessions) {
    throw new Error("chatStartupSessions must not exceed sessions");
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
  const stressCounts = options.teamStress
    ? {
        subagent: options.retainedRuns,
        archivedDashboard: Math.floor((options.sessions * 4_400) / 10_800),
        dashboard: Math.floor((options.sessions * 400) / 10_800),
        explicit: Math.floor((options.sessions * 200) / 10_800),
        channel: 0,
        cron: 0,
        other: 0,
      }
    : undefined;
  const stressTargets: Array<{ sessionKey: string; agentId: string }> = [];
  const latestCreation =
    options.retainedRuns > 0
      ? options.now - 60_000 - options.retainedRuns * TEAM_SHAPE_RUN_SLOT_MS
      : options.now;
  for (let offset = 0; offset < options.sessions; offset += 100) {
    runOpenClawAgentWriteTransaction((database) => {
      for (let index = offset; index < Math.min(offset + 100, options.sessions); index++) {
        const sessionId = `team-shape-session-${index}`;
        const startupUuid = `${(index + 1).toString(16).padStart(8, "0")}-1659-4000-8000-000000000001`;
        const startupTarget = index < chatStartupSessions;
        const isChild = index >= rootCount && index < rootCount + options.retainedRuns;
        // Keep child ordering aligned with seedTeamShapeExtras' retained-run owner.
        const rootIndex = index < rootCount ? index : index - options.retainedRuns;
        const stressCategory = !stressCounts
          ? undefined
          : isChild
            ? "subagent"
            : rootIndex < stressCounts.dashboard
              ? "dashboard"
              : rootIndex < stressCounts.dashboard + stressCounts.explicit
                ? "explicit"
                : rootIndex <
                    stressCounts.dashboard + stressCounts.explicit + stressCounts.archivedDashboard
                  ? "archivedDashboard"
                  : index % 25 === 0
                    ? "channel"
                    : index % 25 === 1
                      ? "cron"
                      : "other";
        const sessionKey =
          stressCategory === "dashboard" || stressCategory === "archivedDashboard"
            ? `agent:main:dashboard:${startupUuid}`
            : stressCategory === "subagent"
              ? `agent:main:subagent:${startupUuid}`
              : stressCategory === "channel"
                ? `agent:main:discord:channel:synthetic-${index}`
                : stressCategory === "cron"
                  ? `agent:main:cron:synthetic-${index}`
                  : startupTarget
                    ? `agent:main:dashboard:${startupUuid}`
                    : `agent:main:${sessionId}`;
        // Keep the live stress cohort inside normal maintenance age limits for the campaign.
        const ageDays = stressCategory === "dashboard" ? 6 : stressCategory ? 29 : 30;
        const updatedAt = options.now - Math.floor(random() ** 2 * ageDays * DAY_MS);
        const createdAt = Math.min(updatedAt - Math.floor(random() * 7 * DAY_MS), latestCreation);
        const profileId = `team-shape-profile-${index % 24}`;
        const visibility = startupTarget
          ? "shared"
          : VISIBILITIES[index % 10 < 7 ? 0 : (index % 10) - 6]!;
        const archived = stressCategory
          ? stressCategory === "archivedDashboard"
          : !startupTarget && index % 5 === 0;
        if (
          stressCounts &&
          (stressCategory === "channel" || stressCategory === "cron" || stressCategory === "other")
        ) {
          stressCounts[stressCategory]++;
        }
        if (stressCategory && !archived && !isChild && stressTargets.length < 64) {
          stressTargets.push({ sessionKey, agentId: "main" });
        }
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
          ...(startupTarget && index % 2 === 1
            ? { providerOverride: "openai", modelOverride: "gpt-4.1" }
            : {}),
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
  // Offline native fixture writes model durable inputs left after an interrupted request.
  // No delivery/replay metadata is present, so Gateway recovery keeps them for display.
  for (const [index, session] of sessions.slice(0, chatStartupSessions).entries()) {
    for (let input = 0; input < 2; input++) {
      const id = `startup-pending-${index}-${input}`;
      const identity = {
        ...session,
        inputId: id,
        runId: id,
        idempotencyKey: id,
        requestHash: createHash("sha256").update(id).digest("hex"),
        lifecycleGeneration: "synthetic-prior-process",
      };
      const owner = {
        writeTransaction: <T>(
          operationLabel: string,
          _owner: string,
          write: (database: OpenClawAgentDatabase) => T,
        ) => runOpenClawAgentWriteTransaction(write, databaseOptions, { operationLabel }),
        admit: () => {},
      };
      mutatePendingInput(
        {
          ...identity,
          kind: "stage",
          expected: { kind: "stage", current: true },
          trackCompletion: false,
          messageJson: JSON.stringify({
            role: "user",
            content: `Synthetic interrupted chat input ${index}/${input}`,
            timestamp: options.now,
            idempotencyKey: id,
          }),
        },
        owner,
        () => {},
      );
      mutatePendingInput(
        { ...identity, kind: "finish", disposition: "interrupted" },
        owner,
        () => {},
      );
    }
    await yieldTurn();
  }
  let logicalTranscriptBytes = 0;
  let baselineTranscriptBytes = 0;
  let thinkingSignatureBytes = 0;
  let transcriptMessages = 0;
  let cumulativeWeight = 0;
  for (const [index, session] of sessions.entries()) {
    cumulativeWeight += weights[index]!;
    const target = Math.floor((cumulativeWeight / totalWeight) * transcriptBytes);
    let remaining = target - baselineTranscriptBytes;
    let longEntriesRemaining = index < longTranscriptSessions ? longTranscriptEntries : 0;
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
    while (remaining > 0 || longEntriesRemaining > 0) {
      const longEntry = remaining === 0;
      const bytes = longEntry ? 1024 : Math.min(MESSAGE_BYTES, remaining);
      const text = content
        .update(zeros.subarray(0, Math.ceil((bytes * 3) / 4)))
        .toString("base64")
        .slice(0, bytes);
      const id = `team-shape-message-${index}-${messageIndex}`;
      const assistant = messageIndex % 2 === 1;
      const thinkingSignature =
        longEntry && assistant
          ? content.update(zeros.subarray(0, 12 * 1024)).toString("base64")
          : undefined;
      events.push({
        type: "message",
        id,
        parentId,
        timestamp: new Date(timestamps[index]!).toISOString(),
        message: {
          role: assistant ? "assistant" : "user",
          content: [
            ...(thinkingSignature
              ? [
                  {
                    type: "thinking",
                    thinking: "Inspecting the synthetic task.",
                    thinkingSignature,
                  },
                ]
              : []),
            { type: "text", text },
          ],
          timestamp: timestamps[index]!,
        },
      });
      parentId = id;
      messageIndex++;
      transcriptMessages++;
      logicalTranscriptBytes += bytes;
      if (longEntry) {
        longEntriesRemaining--;
      } else {
        remaining -= bytes;
        baselineTranscriptBytes += bytes;
      }
      thinkingSignatureBytes += thinkingSignature?.length ?? 0;
      batchBytes += bytes + (thinkingSignature?.length ?? 0);
      if (batchBytes >= TRANSACTION_BYTES) {
        flush();
        if (longTranscriptEntries > 0) {
          await waitForTeamShapeWriteBudget();
        }
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
    longTranscriptEntries,
    longTranscriptSessions: longTranscriptEntries > 0 ? longTranscriptSessions : 0,
    ...(chatStartupSessions
      ? {
          chatStartupTargets: sessions
            .slice(0, chatStartupSessions)
            .map((session, index) =>
              Object.assign(
                { sessionKey: session.sessionKey, minimumPendingInputs: 2 },
                index % 2 === 0
                  ? { shortId: (index + 1).toString(16).padStart(8, "0") }
                  : { requireMetadata: true },
                index < longTranscriptSessions && longTranscriptEntries > 0
                  ? { minimumMessages: 1 }
                  : {},
              ),
            ),
        }
      : {}),
    thinkingSignatureBytes,
    visibilityCounts,
    ownerCount,
    participantCount,
    archivedCount,
    ...(stressCounts ? { stressCounts, stressTargets } : {}),
    generationMs: performance.now() - started,
  };
}
