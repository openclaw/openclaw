// SQLite sessions/transcripts flip proof runner exercises an isolated live gateway lifecycle.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { appendTranscriptMessage } from "../../src/config/sessions/session-accessor.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { sleep } from "../../src/utils.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";

type DoctorMode = "import" | "inspect" | "validate";

type DoctorCommandEvidence = {
  code: number | null;
  mode: DoctorMode;
  stderrTail: string;
  stdoutTail: string;
  totals?: Record<string, unknown>;
};

type FileInventoryEntry = {
  path: string;
  bytes: number;
  lines?: number;
};

type SqliteSessionEntryEvidence = {
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

type SqliteEvidence = {
  exists: boolean;
  path: string;
  sessionEntries: number;
  sessions: number;
  transcriptEvents: number;
  trackedEntries: SqliteSessionEntryEvidence[];
};

type ProofCheckpoint = {
  activeJsonl: FileInventoryEntry[];
  archiveArtifacts: FileInventoryEntry[];
  doctor?: DoctorCommandEvidence;
  gatewayLogTail?: string;
  label: string;
  sqlite: SqliteEvidence;
};

export type SqliteSessionsTranscriptsFlipProofReport = {
  ok: boolean;
  agentId: string;
  checkpoints: ProofCheckpoint[];
  deleteSessionKey: string;
  failures: string[];
  legacySessionId: string;
  resetSessionKey: string;
  sharedSessionKeys: string[];
  stateDir: string;
};

type ProofContext = {
  activeSessionsDir: string;
  agentDbPath: string;
  agentId: string;
  archiveRoots: string[];
  deleteSessionKey: string;
  legacySessionId: string;
  resetSessionKey: string;
  sharedSessionKeys: string[];
  stateDir: string;
  storePath: string;
  trackedSessionKeys: string[];
};

type RunOptions = {
  print?: boolean;
};

const AGENT_ID = "main";
const RESET_SESSION_KEY = "agent:main:main";
const DELETE_SESSION_KEY = "agent:main:dashboard:sqlite-delete";
const SHARED_SESSION_KEYS = [
  "agent:main:dashboard:sqlite-shared-a",
  "agent:main:dashboard:sqlite-shared-b",
] as const;

/** Runs the isolated live gateway SQLite flip proof and returns structured evidence. */
export async function runSqliteSessionsTranscriptsFlipProof(
  options: RunOptions = {},
): Promise<SqliteSessionsTranscriptsFlipProofReport> {
  const print = options.print ?? false;
  const inst = await createOpenClawTestInstance({
    name: `sqlite-sessions-transcripts-flip-${randomUUID()}`,
    startTimeoutMs: 90_000,
    stopTimeoutMs: 3_000,
  });
  const context = buildProofContext(inst.stateDir);
  const checkpoints: ProofCheckpoint[] = [];
  const failures: string[] = [];

  const record = async (label: string, doctor?: DoctorCommandEvidence) => {
    const checkpoint = await captureCheckpoint(context, label, {
      doctor,
      gatewayLogTail: inst.logs(),
    });
    checkpoints.push(checkpoint);
    validateCheckpointInvariants(context, checkpoint, failures);
    if (print) {
      printCheckpoint(checkpoint);
    }
    return checkpoint;
  };

  try {
    await seedLegacySessionStore(context);
    await record("seeded-legacy-store");

    const importDoctor = await runDoctor(inst, "import", context.storePath);
    await record("after-doctor-import", importDoctor);

    const inspectDoctor = await runDoctor(inst, "inspect", context.storePath);
    await record("after-doctor-inspect", inspectDoctor);

    const validateDoctor = await runDoctor(inst, "validate", context.storePath);
    await record("after-doctor-validate", validateDoctor);

    await inst.startGateway();
    await record("gateway-started");

    const client = await connectGatewayClient({
      url: inst.url,
      token: inst.gatewayToken,
      clientDisplayName: "sqlite-sessions-transcripts-flip-proof",
      requestTimeoutMs: 20_000,
      timeoutMs: 20_000,
    });
    try {
      await requireHistoryContains(client, context.resetSessionKey, "legacy hello");
    } finally {
      await disconnectGatewayClient(client);
    }

    await inst.stopGateway();
    await inst.startGateway();
    await record("after-gateway-restart");

    const restartedClient = await connectGatewayClient({
      url: inst.url,
      token: inst.gatewayToken,
      clientDisplayName: "sqlite-sessions-transcripts-flip-proof-restart",
      requestTimeoutMs: 20_000,
      timeoutMs: 20_000,
    });
    try {
      await requireHistoryContains(restartedClient, context.resetSessionKey, "legacy hello");
      await sendGatewayUserMessage(
        restartedClient,
        context.resetSessionKey,
        "sqlite user-facing send before reset",
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        context.legacySessionId,
        "user",
        "sqlite user-facing send before reset",
      );
      await record("after-chat-send");

      const resetSessionId = await resetSession(restartedClient, context.resetSessionKey);
      await record("after-sessions-reset");

      await appendProofMessage(
        context,
        resetSessionId,
        context.resetSessionKey,
        "sqlite appended after reset",
      );
      await requireHistoryContains(restartedClient, context.resetSessionKey, "sqlite appended");
      await waitForSqliteEvents(context.agentDbPath, resetSessionId, 1);
      await record("after-transcript-append");

      await deleteSession(restartedClient, context.deleteSessionKey);
      await record("after-sessions-delete");

      await deleteSession(restartedClient, context.sharedSessionKeys[0]);
      await requireTrackedSession(restartedClient, context.sharedSessionKeys[1]);
      await record("after-shared-first-delete");

      await deleteSession(restartedClient, context.sharedSessionKeys[1]);
      await record("after-shared-final-delete");
    } finally {
      await disconnectGatewayClient(restartedClient);
    }

    const finalInspectDoctor = await runDoctor(inst, "inspect", context.storePath);
    await record("after-final-doctor-inspect", finalInspectDoctor);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    await record("failure");
  } finally {
    await inst.cleanup();
  }

  const report: SqliteSessionsTranscriptsFlipProofReport = {
    ok: failures.length === 0,
    agentId: context.agentId,
    checkpoints,
    deleteSessionKey: context.deleteSessionKey,
    failures,
    legacySessionId: context.legacySessionId,
    resetSessionKey: context.resetSessionKey,
    sharedSessionKeys: [...context.sharedSessionKeys],
    stateDir: context.stateDir,
  };
  if (print) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function buildProofContext(stateDir: string): ProofContext {
  const agentDir = path.join(stateDir, "agents", AGENT_ID);
  const activeSessionsDir = path.join(agentDir, "sessions");
  return {
    activeSessionsDir,
    agentDbPath: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
    agentId: AGENT_ID,
    archiveRoots: [path.join(agentDir, "session-sqlite-import-archive"), activeSessionsDir],
    deleteSessionKey: DELETE_SESSION_KEY,
    legacySessionId: "sqlite-legacy-main",
    resetSessionKey: RESET_SESSION_KEY,
    sharedSessionKeys: [...SHARED_SESSION_KEYS],
    stateDir,
    storePath: path.join(activeSessionsDir, "sessions.json"),
    trackedSessionKeys: [RESET_SESSION_KEY, DELETE_SESSION_KEY, ...SHARED_SESSION_KEYS],
  };
}

async function seedLegacySessionStore(context: ProofContext): Promise<void> {
  await fs.mkdir(context.activeSessionsDir, { recursive: true });
  const now = Date.now();
  const entries = {
    [context.resetSessionKey]: legacyEntry(context.legacySessionId, now),
    [context.deleteSessionKey]: legacyEntry("sqlite-delete-session", now - 1_000),
    [context.sharedSessionKeys[0]]: legacyEntry("sqlite-shared-session", now - 2_000, {
      sessionFile: "sqlite-shared-a.jsonl",
    }),
    [context.sharedSessionKeys[1]]: legacyEntry("sqlite-shared-session", now - 3_000, {
      sessionFile: "sqlite-shared-b.jsonl",
    }),
  };
  await fs.writeFile(context.storePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await writeTranscript(context.activeSessionsDir, context.legacySessionId, [
    legacySessionEvent(context.legacySessionId),
    { type: "message", id: "sqlite-user-1", message: { role: "user", content: "legacy hello" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-delete-session", [
    legacySessionEvent("sqlite-delete-session"),
    { type: "message", id: "sqlite-delete-1", message: { role: "user", content: "delete me" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-shared-a", [
    legacySessionEvent("sqlite-shared-session"),
    { type: "message", id: "sqlite-shared-1", message: { role: "user", content: "shared" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-shared-b", [
    legacySessionEvent("sqlite-shared-session"),
    { type: "message", id: "sqlite-shared-2", message: { role: "user", content: "shared b" } },
  ]);
  await fs.writeFile(
    path.join(context.activeSessionsDir, `${context.legacySessionId}.trajectory.jsonl`),
    `${JSON.stringify({ type: "trajectory", sessionId: context.legacySessionId })}\n`,
    { mode: 0o600 },
  );
  const archiveDir = path.join(context.activeSessionsDir, "archive-fixture");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(
    path.join(archiveDir, "cold-archive.jsonl"),
    `${JSON.stringify({ type: "event", id: "cold-archive" })}\n`,
    { mode: 0o600 },
  );
}

function legacyEntry(
  sessionId: string,
  updatedAt: number,
  options: { sessionFile?: string } = {},
): Record<string, unknown> {
  return {
    channel: "cli",
    chatType: "direct",
    sessionFile: options.sessionFile ?? `${sessionId}.jsonl`,
    sessionId,
    sessionStartedAt: updatedAt - 500,
    updatedAt,
  };
}

function legacySessionEvent(sessionId: string): Record<string, unknown> {
  return { type: "session", sessionId };
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${body}\n`, { mode: 0o600 });
}

async function runDoctor(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  mode: DoctorMode,
  storePath: string,
): Promise<DoctorCommandEvidence> {
  const result = await inst.cli(
    ["doctor", "--session-sqlite", mode, "--session-sqlite-store", storePath, "--json"],
    { timeoutMs: 60_000 },
  );
  const parsed = parseJsonObject(result.stdout);
  return {
    code: result.code,
    mode,
    stderrTail: tail(result.stderr),
    stdoutTail: tail(result.stdout),
    ...(parsed && typeof parsed.totals === "object"
      ? { totals: parsed.totals as Record<string, unknown> }
      : {}),
  };
}

async function appendProofMessage(
  context: ProofContext,
  sessionId: string,
  sessionKey: string,
  message: string,
): Promise<void> {
  const result = await appendTranscriptMessage(
    {
      agentId: context.agentId,
      sessionId,
      sessionKey,
      storePath: context.storePath,
    },
    {
      message: {
        role: "assistant",
        content: message,
        timestamp: Date.now(),
      },
    },
  );
  if (!result?.appended || !result.messageId) {
    throw new Error(`appendTranscriptMessage failed for ${sessionKey}`);
  }
}

async function resetSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<string> {
  const result: { ok?: boolean; entry?: { sessionId?: string } } = await client.request(
    "sessions.reset",
    { key, reason: "reset" },
  );
  if (result?.ok !== true || !result.entry?.sessionId) {
    throw new Error(`sessions.reset failed: ${JSON.stringify(result)}`);
  }
  return result.entry.sessionId;
}

async function sendGatewayUserMessage(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
  message: string,
): Promise<string> {
  const result: { runId?: string; status?: string } = await client.request(
    "chat.send",
    {
      sessionKey,
      message,
      idempotencyKey: `sqlite-send-${randomUUID()}`,
    },
    { timeoutMs: 20_000 },
  );
  if (result?.status !== "started" || typeof result.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(result)}`);
  }
  return result.runId;
}

async function deleteSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<void> {
  const result: { ok?: boolean; deleted?: boolean } = await client.request("sessions.delete", {
    key,
    deleteTranscript: true,
  });
  if (result?.ok !== true || result.deleted !== true) {
    throw new Error(`sessions.delete failed for ${key}: ${JSON.stringify(result)}`);
  }
}

async function requireTrackedSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<void> {
  const result: { sessions?: Array<{ key?: string }> } = await client.request("sessions.list", {});
  if (!result.sessions?.some((session) => session.key === key)) {
    throw new Error(`expected session ${key} to remain listed`);
  }
}

async function requireHistoryContains(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
  expected: string,
): Promise<void> {
  const result: { messages?: unknown[] } = await client.request("chat.history", {
    sessionKey,
    limit: 50,
  });
  const text = JSON.stringify(result.messages ?? []);
  if (!text.includes(expected)) {
    throw new Error(`chat.history for ${sessionKey} did not contain ${JSON.stringify(expected)}`);
  }
}

async function waitForHistoryContains(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await requireHistoryContains(client, sessionKey, expected);
      return;
    } catch {
      await sleep(50);
    }
  }
  await requireHistoryContains(client, sessionKey, expected);
}

async function waitForSqliteEvents(
  dbPath: string,
  sessionId: string,
  minEvents: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const sqlite = readSqliteEvidence(dbPath, []);
    const row = sqlite.trackedEntries.find((entry) => entry.sessionId === sessionId);
    if ((row?.transcriptEvents ?? 0) >= minEvents) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${minEvents} SQLite events for ${sessionId}`);
}

async function waitForSqliteMessageContains(
  dbPath: string,
  sessionId: string,
  role: "assistant" | "user",
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const messages = readSqliteTranscriptMessages(dbPath, sessionId);
    if (
      messages.some(
        (message) => message.role === role && JSON.stringify(message.content).includes(expected),
      )
    ) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for SQLite ${role} transcript message containing ${JSON.stringify(
      expected,
    )} for ${sessionId}: ${JSON.stringify(readSqliteTranscriptMessages(dbPath, sessionId))}`,
  );
}

function readSqliteTranscriptMessages(
  dbPath: string,
  sessionId: string,
): Array<{ content?: unknown; role?: string }> {
  if (!fsSync.existsSync(dbPath)) {
    return [];
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT event_json AS eventJson
         FROM transcript_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId) as Array<{ eventJson?: unknown }>;
    return rows.flatMap((row) => {
      if (typeof row.eventJson !== "string") {
        return [];
      }
      const event = parseJsonObject(row.eventJson);
      const message =
        event && typeof event.message === "object" && event.message !== null
          ? (event.message as { content?: unknown; role?: unknown })
          : undefined;
      return typeof message?.role === "string"
        ? [{ role: message.role, content: message.content }]
        : [];
    });
  } finally {
    db.close();
  }
}

async function captureCheckpoint(
  context: ProofContext,
  label: string,
  options: { doctor?: DoctorCommandEvidence; gatewayLogTail?: string },
): Promise<ProofCheckpoint> {
  return {
    activeJsonl: await inventoryActiveJsonl(context.activeSessionsDir),
    archiveArtifacts: await inventoryArchiveArtifacts(context),
    ...(options.doctor ? { doctor: options.doctor } : {}),
    gatewayLogTail: tail(options.gatewayLogTail ?? ""),
    label,
    sqlite: readSqliteEvidence(context.agentDbPath, context.trackedSessionKeys),
  };
}

async function inventoryActiveJsonl(sessionsDir: string): Promise<FileInventoryEntry[]> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  return await Promise.all(
    files.map((entry) => inventoryFile(path.join(sessionsDir, entry.name), sessionsDir)),
  );
}

async function inventoryArchiveArtifacts(context: ProofContext): Promise<FileInventoryEntry[]> {
  const roots = context.archiveRoots;
  const files: FileInventoryEntry[] = [];
  for (const root of roots) {
    await walkFiles(root, async (filePath) => {
      const isActiveDirectFile =
        filePath.startsWith(context.activeSessionsDir) &&
        path.dirname(filePath) === context.activeSessionsDir;
      if (isActiveDirectFile) {
        return;
      }
      const basename = path.basename(filePath);
      const archiveLike =
        basename.includes(".jsonl") ||
        basename.includes(".reset.") ||
        basename.includes(".deleted.") ||
        basename.includes(".bak.");
      if (archiveLike) {
        files.push(await inventoryFile(filePath, context.stateDir));
      }
    });
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(filePath, visit);
    } else if (entry.isFile()) {
      await visit(filePath);
    }
  }
}

async function inventoryFile(filePath: string, relativeRoot: string): Promise<FileInventoryEntry> {
  const [stat, text] = await Promise.all([
    fs.stat(filePath),
    fs.readFile(filePath, "utf8").catch(() => undefined),
  ]);
  return {
    path: path.relative(relativeRoot, filePath),
    bytes: stat.size,
    ...(text !== undefined ? { lines: text.split(/\r?\n/u).filter(Boolean).length } : {}),
  };
}

function readSqliteEvidence(dbPath: string, trackedSessionKeys: readonly string[]): SqliteEvidence {
  if (!fsSync.existsSync(dbPath)) {
    return {
      exists: false,
      path: dbPath,
      sessionEntries: 0,
      sessions: 0,
      trackedEntries: [],
      transcriptEvents: 0,
    };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const trackedEntries = readTrackedEntries(db, trackedSessionKeys);
    return {
      exists: true,
      path: dbPath,
      sessionEntries: scalarNumber(db, "SELECT COUNT(*) AS count FROM session_entries"),
      sessions: scalarNumber(db, "SELECT COUNT(*) AS count FROM sessions"),
      trackedEntries,
      transcriptEvents: scalarNumber(db, "SELECT COUNT(*) AS count FROM transcript_events"),
    };
  } finally {
    db.close();
  }
}

function readTrackedEntries(
  db: DatabaseSync,
  trackedSessionKeys: readonly string[],
): SqliteSessionEntryEvidence[] {
  const rows = db
    .prepare(
      `SELECT session_key AS sessionKey, session_id AS sessionId
       FROM session_entries
       ORDER BY session_key ASC`,
    )
    .all() as Array<{ sessionId?: unknown; sessionKey?: unknown }>;
  return rows
    .filter(
      (row) =>
        trackedSessionKeys.length === 0 ||
        trackedSessionKeys.includes(typeof row.sessionKey === "string" ? row.sessionKey : ""),
    )
    .map((row) => {
      const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
      return {
        sessionId,
        sessionKey: typeof row.sessionKey === "string" ? row.sessionKey : "",
        transcriptEvents: scalarNumber(
          db,
          "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
          [sessionId],
        ),
      };
    });
}

function scalarNumber(db: DatabaseSync, sql: string, values: unknown[] = []): number {
  const row = db.prepare(sql).get(...values) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function validateCheckpointInvariants(
  context: ProofContext,
  checkpoint: ProofCheckpoint,
  failures: string[],
): void {
  if (checkpoint.label !== "seeded-legacy-store" && checkpoint.activeJsonl.length > 0) {
    failures.push(
      `${checkpoint.label}: active sessions directory still has JSONL files: ${checkpoint.activeJsonl
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  if (checkpoint.label.startsWith("after-doctor") && checkpoint.doctor?.code !== 0) {
    failures.push(`${checkpoint.label}: doctor ${checkpoint.doctor.mode} exited non-zero`);
  }
  if (
    checkpoint.label.startsWith("after-doctor") &&
    checkpoint.sqlite.exists &&
    checkpoint.sqlite.sessionEntries > 0 &&
    checkpoint.sqlite.transcriptEvents === 0
  ) {
    failures.push(`${checkpoint.label}: SQLite has session entries but no transcript events`);
  }
  if (
    checkpoint.label === "after-shared-first-delete" &&
    !checkpoint.sqlite.trackedEntries.some(
      (entry) => entry.sessionKey === context.sharedSessionKeys[1],
    )
  ) {
    failures.push(`${checkpoint.label}: shared sibling entry was deleted too early`);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tail(value: string, maxChars = 8_000): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function printCheckpoint(checkpoint: ProofCheckpoint): void {
  process.stderr.write(
    [
      `[sqlite-sessions-transcripts-flip-proof] ${checkpoint.label}`,
      `  sqlite sessions=${checkpoint.sqlite.sessions} entries=${checkpoint.sqlite.sessionEntries} transcriptEvents=${checkpoint.sqlite.transcriptEvents}`,
      `  activeJsonl=${checkpoint.activeJsonl.length} archiveArtifacts=${checkpoint.archiveArtifacts.length}`,
      checkpoint.doctor
        ? `  doctor ${checkpoint.doctor.mode} code=${String(checkpoint.doctor.code)} totals=${JSON.stringify(
            checkpoint.doctor.totals ?? {},
          )}`
        : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n") + "\n",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runSqliteSessionsTranscriptsFlipProof({ print: true });
  process.exit(report.ok ? 0 : 1);
}
