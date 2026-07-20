// Benchmarks real Codex/Copilot transcript mirror owners against 100k-message sessions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { codexTranscriptMirrorRuntime } from "../extensions/codex/src/app-server/transcript-mirror.js";
import { attachCodexMirrorIdentity } from "../extensions/codex/src/app-server/upstream-prompt-provenance.js";
import {
  attachCopilotMirrorIdentity,
  dualWriteCopilotTranscriptBestEffort,
} from "../extensions/copilot/src/dual-write-transcripts.js";
import { upsertSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { AgentMessage } from "../src/plugin-sdk/agent-core.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";

const EVENT_COUNT = 100_000;
const WARMUPS = 2;
const RUNS = 12;
const NEW_MESSAGES_PER_OPERATION = 2;
const PAYLOAD_TEXT = "x".repeat(64);

type MirrorKind = "codex" | "copilot";
type MirrorTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

function readMirrorKind(): MirrorKind {
  const value = process.argv.find((arg) => arg.startsWith("--mirror="))?.slice("--mirror=".length);
  if (value === "codex" || value === "copilot") {
    return value;
  }
  throw new Error("usage: bench-transcript-mirrors.ts --mirror=codex|copilot");
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const upperIndex = Math.floor(sorted.length / 2);
  const upper = sorted[upperIndex] ?? 0;
  const lower = sorted.length % 2 === 0 ? (sorted[upperIndex - 1] ?? upper) : upper;
  return Number(((lower + upper) / 2).toFixed(3));
}

function readSourceSha(): string {
  const value = process.argv
    .find((arg) => arg.startsWith("--source-sha="))
    ?.slice("--source-sha=".length);
  if (!value || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("benchmark requires --source-sha=<40-character commit SHA>");
  }
  const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  }).trim();
  if (value !== checkoutSha) {
    throw new Error(`source SHA ${value} does not match checkout HEAD ${checkoutSha}`);
  }
  return value;
}

function existingKeys(kind: MirrorKind): readonly [string, string] {
  return kind === "codex"
    ? ["codex-existing-user", "codex-app-server:benchmark:existing-assistant"]
    : ["copilot-existing-user", "copilot:benchmark:existing-assistant"];
}

/** Seeds one fully indexed linear transcript without charging setup to mirror timings. */
function seedTranscript(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
  keys: readonly [string, string],
): void {
  const insertEvent = database.db.prepare(
    `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertIdentity = database.db.prepare(
    `INSERT INTO transcript_event_identities (
       session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
     ) VALUES (?, ?, ?, 'message', ?, ?, ?)`,
  );
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events (
       session_id, active_position, event_seq, message_position
     ) VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let seq = 0; seq < EVENT_COUNT; seq += 1) {
      const eventId = `benchmark-event-${seq}`;
      const parentId = seq === 0 ? null : `benchmark-event-${seq - 1}`;
      const idempotencyKey = seq === 0 ? keys[0] : seq === 1 ? keys[1] : `seed:${sessionId}:${seq}`;
      const role = seq === 0 ? "user" : "assistant";
      const event = {
        id: eventId,
        message: {
          content: role === "user" ? PAYLOAD_TEXT : [{ type: "text", text: PAYLOAD_TEXT }],
          idempotencyKey,
          role,
          timestamp: now + seq,
        },
        parentId,
        timestamp: now + seq,
        type: "message",
      };
      insertEvent.run(sessionId, seq, JSON.stringify(event), now + seq);
      const identityValues = [
        sessionId,
        eventId,
        seq,
        parentId,
        idempotencyKey,
        now + seq,
      ] satisfies SQLInputValue[];
      insertIdentity.run(...identityValues);
      insertActive.run(sessionId, seq, seq, seq);
    }
    database.db
      .prepare(
        `INSERT INTO session_transcript_index_state (
           session_id, indexed_seq, leaf_event_id, needs_rebuild,
           active_event_count, active_message_count, updated_at
         ) VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        sessionId,
        EVENT_COUNT - 1,
        `benchmark-event-${EVENT_COUNT - 1}`,
        EVENT_COUNT,
        EVENT_COUNT,
        now + EVENT_COUNT,
      );
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function userMessage(idempotencyKey: string, ordinal: number): AgentMessage {
  return {
    role: "user",
    content: `benchmark user ${ordinal}`,
    idempotencyKey,
    timestamp: 2_000_000_000_000 + ordinal,
  } as AgentMessage;
}

function assistantMessage(ordinal: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `benchmark assistant ${ordinal}` }],
    timestamp: 2_000_000_100_000 + ordinal,
  } as AgentMessage;
}

function buildBatch(kind: MirrorKind, ordinal: number): AgentMessage[] {
  const [existingUserKey] = existingKeys(kind);
  if (kind === "codex") {
    return [
      userMessage(existingUserKey, -1),
      attachCodexMirrorIdentity(assistantMessage(-1), "existing-assistant"),
      userMessage(`codex-new-user-${ordinal}`, ordinal),
      attachCodexMirrorIdentity(assistantMessage(ordinal), `new-assistant-${ordinal}`),
    ];
  }
  return [
    userMessage(existingUserKey, -1),
    attachCopilotMirrorIdentity(assistantMessage(-1), "existing-assistant"),
    userMessage(`copilot-new-user-${ordinal}`, ordinal),
    attachCopilotMirrorIdentity(assistantMessage(ordinal), `new-assistant-${ordinal}`),
  ];
}

async function runMirror(kind: MirrorKind, target: MirrorTarget, ordinal: number): Promise<void> {
  const messages = buildBatch(kind, ordinal);
  if (kind === "codex") {
    await codexTranscriptMirrorRuntime.mirror({
      ...target,
      idempotencyScope: "codex-app-server:benchmark",
      messages,
    });
    return;
  }
  await dualWriteCopilotTranscriptBestEffort({
    ...target,
    idempotencyScope: "copilot:benchmark",
    messages,
  });
}

async function measure(kind: MirrorKind, target: MirrorTarget): Promise<number[]> {
  for (let ordinal = 0; ordinal < WARMUPS; ordinal += 1) {
    await runMirror(kind, target, ordinal);
  }
  const durations: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const startedAt = performance.now();
    await runMirror(kind, target, WARMUPS + run);
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

async function main(): Promise<void> {
  const kind = readMirrorKind();
  const sourceSha = readSourceSha();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${kind}-mirror-bench-`));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const agentId = "benchmark";
  const sessionId = `${kind}-mirror-benchmark`;
  const sessionKey = `agent:${agentId}:${sessionId}`;
  try {
    const database = openOpenClawAgentDatabase({ agentId, env });
    await upsertSessionEntry(
      { agentId, sessionKey, storePath: database.path },
      { sessionId, updatedAt: 1 },
    );
    seedTranscript(database, sessionId, existingKeys(kind));
    const target = { agentId, sessionId, sessionKey, storePath: database.path };
    const beforeMaxRssKb = process.resourceUsage().maxRSS;
    const durations = await measure(kind, target);
    const afterMaxRssKb = process.resourceUsage().maxRSS;
    const row = database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { count: number };
    const expectedEvents = EVENT_COUNT + NEW_MESSAGES_PER_OPERATION * (WARMUPS + RUNS);
    if (row.count !== expectedEvents) {
      throw new Error(`mirror wrote ${row.count} events; expected ${expectedEvents}`);
    }
    console.log(
      JSON.stringify(
        {
          sourceSha,
          mirror: kind,
          fixture: {
            initialMessageEvents: EVENT_COUNT,
            payload: {
              contentBytes: PAYLOAD_TEXT.length,
              indexedIdempotencyKeyPerMessage: true,
              shape: "linear type=message events with user/assistant AgentMessage payloads",
            },
            operation: {
              existingMessages: 2,
              newMessages: NEW_MESSAGES_PER_OPERATION,
              suppliedMessages: 4,
            },
          },
          runtime: {
            arch: process.arch,
            node: process.version,
            platform: `${os.platform()} ${os.release()}`,
          },
          warmups: WARMUPS,
          runs: RUNS,
          latencyMs: {
            median: median(durations),
            p95: percentile(durations, 0.95),
            raw: durations.map((value) => Number(value.toFixed(3))),
          },
          memoryProxy: {
            maxRssKbBeforeOperations: beforeMaxRssKb,
            maxRssKbAfterOperations: afterMaxRssKb,
            maxRssGrowthKb: Math.max(0, afterMaxRssKb - beforeMaxRssKb),
          },
          lockTiming: "not separately instrumented; uncontended end-to-end owner latency reported",
        },
        null,
        2,
      ),
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

await main();
