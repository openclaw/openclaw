// SQLite sessions/transcripts flip proof runner exercises an isolated live gateway lifecycle.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  appendTranscriptMessage,
  type TranscriptEvent,
} from "../../src/config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../../src/config/sessions/session-accessor.sqlite.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import {
  getSessionEntry as getSdkSessionEntry,
  listSessionEntries as listSdkSessionEntries,
  loadTranscriptEventsSync as loadSdkTranscriptEventsSync,
} from "../../src/plugin-sdk/session-store-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
} from "../../src/plugin-sdk/session-transcript-runtime.js";
import { sleep } from "../../src/utils.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";

type DoctorMode = "fix" | "inspect" | "validate";

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
  entry?: Record<string, unknown>;
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
  legacyStateJsonl: FileInventoryEntry[];
  sqlite: SqliteEvidence;
};

type PluginSdkConsumerEvidence = {
  activeJsonlForSessionExists: boolean;
  appendedMessageId: string;
  identityMemoryKey: string;
  latestAssistantTextBeforeAppend: string;
  latestAssistantTextAfterAppend: string;
  listedSessionKeys: string[];
  sessionFileMarker: string;
  sessionId: string;
  sessionKey: string;
  storeTranscriptEvents: number;
  transcriptEventsAfterAppend: number;
  transcriptEventsBeforeAppend: number;
};

export type SqliteSessionsTranscriptsFlipProofReport = {
  ok: boolean;
  agentId: string;
  checkpoints: ProofCheckpoint[];
  concurrentDeleteSessionKey: string;
  concurrentResetSessionKey: string;
  concurrentSendSessionKey: string;
  deleteSessionKey: string;
  failures: string[];
  fullTurnAssistantText: string;
  fullTurnSessionKey: string;
  gatewayEntrypoint: string[];
  legacySessionId: string;
  mockOpenAiRequestLog: string;
  oldStateSessionKeys: string[];
  pluginSdkConsumer?: PluginSdkConsumerEvidence;
  pluginSdkSessionKey: string;
  resetSessionKey: string;
  sharedSessionKeys: string[];
  stateDir: string;
};

type ProofContext = {
  activeSessionsDir: string;
  agentDbPath: string;
  agentId: string;
  archiveRoots: string[];
  concurrentDeleteSessionKey: string;
  concurrentResetSessionKey: string;
  concurrentSendSessionKey: string;
  deleteSessionKey: string;
  fullTurnAssistantText: string;
  fullTurnSessionKey: string;
  legacySessionsDir: string;
  legacySessionId: string;
  mockOpenAiRequestLog: string;
  oldStateSessionKeys: string[];
  pluginSdkAppendText: string;
  pluginSdkSessionKey: string;
  resetSessionKey: string;
  sharedSessionKeys: string[];
  stateDir: string;
  storePath: string;
  trackedSessionKeys: string[];
};

type RunOptions = {
  print?: boolean;
  requireBuiltCli?: boolean;
};

const AGENT_ID = "main";
const RESET_SESSION_KEY = "agent:main:main";
const DELETE_SESSION_KEY = "agent:main:dashboard:sqlite-delete";
const CONCURRENT_SEND_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-send";
const CONCURRENT_RESET_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-reset";
const CONCURRENT_DELETE_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-delete";
const CONCURRENT_SEND_TEXT = "sqlite concurrent send history reset";
const CONCURRENT_DELETE_TEXT = "sqlite concurrent delete while send is active";
const FULL_TURN_ASSISTANT_TEXT = "OPENCLAW_E2E_OK_12";
const FULL_TURN_SESSION_KEY = "agent:main:dashboard:sqlite-full-turn";
const PLUGIN_SDK_APPEND_TEXT = "sqlite sdk consumer appended by identity";
const PLUGIN_SDK_SESSION_KEY = "agent:main:dashboard:sqlite-sdk-consumer";
const SHARED_SESSION_KEYS = [
  "agent:main:dashboard:sqlite-shared-a",
  "agent:main:dashboard:sqlite-shared-b",
] as const;
const OLD_STATE_SESSION_KEYS = [
  "agent:main:+15551234567",
  "agent:main:partial-direct",
  "agent:main:unknown:group:legacy-room",
] as const;

/** Runs the isolated live gateway SQLite flip proof and returns structured evidence. */
export async function runSqliteSessionsTranscriptsFlipProof(
  options: RunOptions = {},
): Promise<SqliteSessionsTranscriptsFlipProofReport> {
  const print = options.print ?? false;
  const mockOpenAiPort = await getFreeTcpPort();
  const inst = await createOpenClawTestInstance({
    name: `sqlite-sessions-transcripts-flip-${randomUUID()}`,
    config: buildMockOpenAiConfig(mockOpenAiPort),
    env: {
      OPENAI_API_KEY: "sk-openclaw-e2e-mock",
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
    startTimeoutMs: 90_000,
    stopTimeoutMs: 3_000,
  });
  const context = buildProofContext(inst.stateDir);
  const checkpoints: ProofCheckpoint[] = [];
  const failures: string[] = [];
  let gatewayEntrypoint: string[] = [];
  let mockOpenAi: ChildProcessWithoutNullStreams | undefined;
  let pluginSdkConsumer: PluginSdkConsumerEvidence | undefined;

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
    gatewayEntrypoint = await inst.entrypoint();
    if (options.requireBuiltCli === true && !isBuiltCliEntrypoint(gatewayEntrypoint)) {
      throw new Error(`expected built CLI entrypoint, got ${gatewayEntrypoint.join(" ")}`);
    }

    mockOpenAi = await startMockOpenAiServer({
      port: mockOpenAiPort,
      requestLogPath: context.mockOpenAiRequestLog,
      responseText: context.fullTurnAssistantText,
    });

    await seedLegacySessionStore(context);
    await record("seeded-legacy-store");

    const fixDoctor = await runDoctorFix(inst);
    await record("after-doctor-fix", fixDoctor);

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

      const fullTurnRunId = await sendGatewayUserMessage(
        restartedClient,
        context.fullTurnSessionKey,
        `Reply with exactly ${context.fullTurnAssistantText}.`,
      );
      await waitForAgentRunOk(restartedClient, fullTurnRunId);
      const fullTurnSessionId = await waitForSqliteSessionId(
        context.agentDbPath,
        context.fullTurnSessionKey,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        fullTurnSessionId,
        "user",
        context.fullTurnAssistantText,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        fullTurnSessionId,
        "assistant",
        context.fullTurnAssistantText,
      );
      await waitForHistoryContains(
        restartedClient,
        context.fullTurnSessionKey,
        context.fullTurnAssistantText,
      );
      await requireMockOpenAiRequest(context.mockOpenAiRequestLog);
      await record("after-full-agent-turn");

      const pluginSdkRunId = await sendGatewayUserMessage(
        restartedClient,
        context.pluginSdkSessionKey,
        `Reply with exactly ${context.fullTurnAssistantText}. SDK consumer proof.`,
      );
      await waitForAgentRunOk(restartedClient, pluginSdkRunId);
      const pluginSdkSessionId = await waitForSqliteSessionId(
        context.agentDbPath,
        context.pluginSdkSessionKey,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        pluginSdkSessionId,
        "assistant",
        context.fullTurnAssistantText,
      );
      pluginSdkConsumer = await runPluginSdkConsumerProbe(context, pluginSdkSessionId);
      await waitForSqliteMessageContains(
        context.agentDbPath,
        pluginSdkSessionId,
        "assistant",
        context.pluginSdkAppendText,
      );
      await record("after-plugin-sdk-consumer");

      await runConcurrentMultiClientLifecycle(inst, context, restartedClient);
      await record("after-concurrent-multi-client");

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
    await stopChildProcess(mockOpenAi);
    await inst.cleanup();
  }

  const report: SqliteSessionsTranscriptsFlipProofReport = {
    ok: failures.length === 0,
    agentId: context.agentId,
    checkpoints,
    concurrentDeleteSessionKey: context.concurrentDeleteSessionKey,
    concurrentResetSessionKey: context.concurrentResetSessionKey,
    concurrentSendSessionKey: context.concurrentSendSessionKey,
    deleteSessionKey: context.deleteSessionKey,
    failures,
    fullTurnAssistantText: context.fullTurnAssistantText,
    fullTurnSessionKey: context.fullTurnSessionKey,
    gatewayEntrypoint,
    legacySessionId: context.legacySessionId,
    mockOpenAiRequestLog: context.mockOpenAiRequestLog,
    oldStateSessionKeys: [...context.oldStateSessionKeys],
    ...(pluginSdkConsumer ? { pluginSdkConsumer } : {}),
    pluginSdkSessionKey: context.pluginSdkSessionKey,
    resetSessionKey: context.resetSessionKey,
    sharedSessionKeys: [...context.sharedSessionKeys],
    stateDir: context.stateDir,
  };
  if (print) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function isBuiltCliEntrypoint(entrypoint: readonly string[]): boolean {
  const [first, ...rest] = entrypoint;
  return rest.length === 0 && (first === "dist/index.js" || first === "dist/index.mjs");
}

function buildProofContext(stateDir: string): ProofContext {
  const agentDir = path.join(stateDir, "agents", AGENT_ID);
  const activeSessionsDir = path.join(agentDir, "sessions");
  const legacySessionsDir = path.join(stateDir, "sessions");
  return {
    activeSessionsDir,
    agentDbPath: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
    agentId: AGENT_ID,
    archiveRoots: [path.join(agentDir, "session-sqlite-import-archive"), activeSessionsDir],
    concurrentDeleteSessionKey: CONCURRENT_DELETE_SESSION_KEY,
    concurrentResetSessionKey: CONCURRENT_RESET_SESSION_KEY,
    concurrentSendSessionKey: CONCURRENT_SEND_SESSION_KEY,
    deleteSessionKey: DELETE_SESSION_KEY,
    fullTurnAssistantText: FULL_TURN_ASSISTANT_TEXT,
    fullTurnSessionKey: FULL_TURN_SESSION_KEY,
    legacySessionsDir,
    legacySessionId: "sqlite-legacy-main",
    mockOpenAiRequestLog: path.join(stateDir, "mock-openai-requests.ndjson"),
    oldStateSessionKeys: [...OLD_STATE_SESSION_KEYS],
    pluginSdkAppendText: PLUGIN_SDK_APPEND_TEXT,
    pluginSdkSessionKey: PLUGIN_SDK_SESSION_KEY,
    resetSessionKey: RESET_SESSION_KEY,
    sharedSessionKeys: [...SHARED_SESSION_KEYS],
    stateDir,
    storePath: path.join(activeSessionsDir, "sessions.json"),
    trackedSessionKeys: [
      RESET_SESSION_KEY,
      DELETE_SESSION_KEY,
      CONCURRENT_SEND_SESSION_KEY,
      CONCURRENT_RESET_SESSION_KEY,
      CONCURRENT_DELETE_SESSION_KEY,
      FULL_TURN_SESSION_KEY,
      PLUGIN_SDK_SESSION_KEY,
      ...SHARED_SESSION_KEYS,
      ...OLD_STATE_SESSION_KEYS,
    ],
  };
}

function buildMockOpenAiConfig(mockPort: number): Record<string, unknown> {
  const modelRef = "openai/gpt-5.5";
  const modelId = "gpt-5.5";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    agents: {
      defaults: {
        model: { primary: modelRef },
        models: {
          [modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { openaiWsWarmup: false, transport: "sse" },
          },
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          agentRuntime: { id: "openclaw" },
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          models: [
            {
              agentRuntime: { id: "openclaw" },
              api: "openai-responses",
              contextTokens: 96_000,
              contextWindow: 128_000,
              cost,
              id: modelId,
              input: ["text", "image"],
              maxTokens: 4_096,
              name: modelId,
              reasoning: false,
            },
          ],
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: { enabled: true },
  };
}

async function getFreeTcpPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral mock OpenAI port");
  }
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
  return addr.port;
}

async function startMockOpenAiServer(params: {
  port: number;
  requestLogPath: string;
  responseText: string;
}): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn("node", ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOCK_PORT: String(params.port),
      MOCK_REQUEST_LOG: params.requestLogPath,
      SUCCESS_MARKER: params.responseText,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `mock OpenAI exited before listening (code=${String(child.exitCode)} signal=${String(
          child.signalCode,
        )})\n${tail(output)}`,
      );
    }
    if (output.includes("mock-openai listening")) {
      return child;
    }
    await sleep(25);
  }
  await stopChildProcess(child);
  throw new Error(`timeout waiting for mock OpenAI server\n${tail(output)}`);
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    sleep(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function seedLegacySessionStore(context: ProofContext): Promise<void> {
  await fs.mkdir(context.activeSessionsDir, { recursive: true });
  await fs.mkdir(context.legacySessionsDir, { recursive: true });
  await fs.mkdir(path.join(context.stateDir, "agent"), { recursive: true });
  const now = Date.now();
  const entries = {
    [context.concurrentDeleteSessionKey]: legacyEntry("sqlite-concurrent-delete", now - 8_000),
    [context.concurrentResetSessionKey]: legacyEntry("sqlite-concurrent-reset", now - 9_000),
    [context.deleteSessionKey]: legacyEntry("sqlite-delete-session", now - 1_000),
    [context.sharedSessionKeys[0]]: legacyEntry("sqlite-shared-session", now - 2_000, {
      sessionFile: "sqlite-shared-a.jsonl",
    }),
    [context.sharedSessionKeys[1]]: legacyEntry("sqlite-shared-session", now - 3_000, {
      sessionFile: "sqlite-shared-b.jsonl",
    }),
  };
  const oldStateEntries = {
    main: legacyEntry(context.legacySessionId, now - 4_000),
    "+15551234567": legacyEntry("sqlite-old-direct", now - 5_000),
    "group:legacy-room": legacyEntry("sqlite-old-group", now - 6_000, {
      room: "legacy-room",
    }),
    "partial-direct": legacyEntry("sqlite-partial-import", now - 7_000),
  };
  await fs.writeFile(context.storePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(context.legacySessionsDir, "sessions.json"),
    `${JSON.stringify(oldStateEntries, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(context.stateDir, "agent", "old-settings.json"),
    `${JSON.stringify({ source: "old-agent-layout" })}\n`,
    { mode: 0o600 },
  );
  await writeTranscript(context.legacySessionsDir, context.legacySessionId, [
    legacySessionEvent(context.legacySessionId),
    { type: "message", id: "sqlite-user-1", message: { role: "user", content: "legacy hello" } },
  ]);
  await writeTranscript(context.legacySessionsDir, "sqlite-old-direct", [
    legacySessionEvent("sqlite-old-direct"),
    { type: "message", id: "sqlite-old-direct-1", message: { role: "user", content: "old dm" } },
  ]);
  await writeTranscript(context.legacySessionsDir, "sqlite-old-group", [
    legacySessionEvent("sqlite-old-group"),
    { type: "message", id: "sqlite-old-group-1", message: { role: "user", content: "old group" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-delete-session", [
    legacySessionEvent("sqlite-delete-session"),
    { type: "message", id: "sqlite-delete-1", message: { role: "user", content: "delete me" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-concurrent-reset", [
    legacySessionEvent("sqlite-concurrent-reset"),
    {
      type: "message",
      id: "sqlite-concurrent-reset-1",
      message: { role: "user", content: "concurrent reset seed" },
    },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-concurrent-delete", [
    legacySessionEvent("sqlite-concurrent-delete"),
    {
      type: "message",
      id: "sqlite-concurrent-delete-1",
      message: { role: "user", content: "concurrent delete seed" },
    },
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
    path.join(context.legacySessionsDir, `${context.legacySessionId}.trajectory.jsonl`),
    `${JSON.stringify({ type: "trajectory", sessionId: context.legacySessionId })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(context.legacySessionsDir, "old-orphan.deleted.jsonl"),
    `${JSON.stringify({ type: "event", id: "old-orphan" })}\n`,
    { mode: 0o600 },
  );
  const archiveDir = path.join(context.activeSessionsDir, "archive-fixture");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(
    path.join(archiveDir, "cold-archive.jsonl"),
    `${JSON.stringify({ type: "event", id: "cold-archive" })}\n`,
    { mode: 0o600 },
  );
  await importSqliteSessionRows({
    agentId: context.agentId,
    entry: {
      ...legacyEntry("sqlite-partial-import", now - 7_000),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: context.agentId,
        sessionId: "sqlite-partial-import",
        storePath: context.storePath,
      }),
    },
    readTranscriptEvents(append) {
      append(legacySessionEvent("sqlite-partial-import"));
      append({
        type: "message",
        id: "sqlite-partial-import-1",
        message: { role: "user", content: "already imported" },
      });
    },
    sessionKey: "agent:main:partial-direct",
    storePath: context.storePath,
  });
}

function legacyEntry(
  sessionId: string,
  updatedAt: number,
  options: { room?: string; sessionFile?: string } = {},
): SessionEntry & { channel: string; chatType: string; room?: string } {
  return {
    channel: "cli",
    chatType: "direct",
    ...(options.room ? { room: options.room } : {}),
    sessionFile: options.sessionFile ?? `${sessionId}.jsonl`,
    sessionId,
    sessionStartedAt: updatedAt - 500,
    updatedAt,
  };
}

function legacySessionEvent(sessionId: string): TranscriptEvent {
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
  mode: Exclude<DoctorMode, "fix">,
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

async function runDoctorFix(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
): Promise<DoctorCommandEvidence> {
  const result = await inst.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
    timeoutMs: 90_000,
  });
  return {
    code: result.code,
    mode: "fix",
    stderrTail: tail(result.stderr),
    stdoutTail: tail(result.stdout),
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

async function runPluginSdkConsumerProbe(
  context: ProofContext,
  sessionId: string,
): Promise<PluginSdkConsumerEvidence> {
  const scope = {
    agentId: context.agentId,
    sessionId,
    sessionKey: context.pluginSdkSessionKey,
    storePath: context.storePath,
  };
  const sessionEntry = getSdkSessionEntry({
    agentId: context.agentId,
    readConsistency: "latest",
    sessionKey: context.pluginSdkSessionKey,
    storePath: context.storePath,
  });
  if (sessionEntry?.sessionId !== sessionId) {
    throw new Error(
      `SDK session store read returned ${JSON.stringify(sessionEntry)} for ${context.pluginSdkSessionKey}`,
    );
  }
  const expectedMarker = formatSqliteSessionFileMarker({
    agentId: context.agentId,
    sessionId,
    storePath: context.storePath,
  });
  if (sessionEntry.sessionFile !== expectedMarker) {
    throw new Error(
      `SDK session store exposed unexpected transcript marker for ${context.pluginSdkSessionKey}: ${String(
        sessionEntry.sessionFile,
      )}`,
    );
  }
  if (fsSync.existsSync(sessionEntry.sessionFile)) {
    throw new Error(`SDK session marker unexpectedly resolves to an active file path`);
  }

  const listedSessionKeys = listSdkSessionEntries({
    agentId: context.agentId,
    storePath: context.storePath,
  }).map((entry) => entry.sessionKey);
  if (!listedSessionKeys.includes(context.pluginSdkSessionKey)) {
    throw new Error(`SDK session list omitted ${context.pluginSdkSessionKey}`);
  }

  const identity = await resolveSessionTranscriptIdentity(scope);
  const latestBefore = await readLatestAssistantTextByIdentity(scope);
  if (latestBefore?.text !== context.fullTurnAssistantText) {
    throw new Error(
      `SDK latest assistant read returned ${JSON.stringify(latestBefore)} for ${context.pluginSdkSessionKey}`,
    );
  }
  const transcriptEventsBeforeAppend = (await readSessionTranscriptEvents(scope)).length;
  const storeTranscriptEvents = loadSdkTranscriptEventsSync(scope).length;
  const activeJsonlPath = path.join(context.activeSessionsDir, `${sessionId}.jsonl`);
  const activeJsonlForSessionExists = fsSync.existsSync(activeJsonlPath);
  if (activeJsonlForSessionExists) {
    throw new Error(`SDK probe found active JSONL for SQLite session at ${activeJsonlPath}`);
  }

  const appended = await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: {
      role: "assistant",
      content: [{ type: "text", text: context.pluginSdkAppendText }],
      timestamp: Date.now(),
    },
  });
  if (!appended?.appended || !appended.messageId) {
    throw new Error(`SDK transcript append failed for ${context.pluginSdkSessionKey}`);
  }

  const latestAfter = await readLatestAssistantTextByIdentity(scope);
  if (latestAfter?.text !== context.pluginSdkAppendText) {
    throw new Error(
      `SDK latest assistant after append returned ${JSON.stringify(latestAfter)} for ${
        context.pluginSdkSessionKey
      }`,
    );
  }
  const transcriptEventsAfterAppend = (await readSessionTranscriptEvents(scope)).length;
  if (transcriptEventsAfterAppend <= transcriptEventsBeforeAppend) {
    throw new Error(
      `SDK transcript append did not increase event count for ${context.pluginSdkSessionKey}`,
    );
  }

  return {
    activeJsonlForSessionExists,
    appendedMessageId: appended.messageId,
    identityMemoryKey: identity.memoryKey,
    latestAssistantTextBeforeAppend: latestBefore.text,
    latestAssistantTextAfterAppend: latestAfter.text,
    listedSessionKeys,
    sessionFileMarker: sessionEntry.sessionFile,
    sessionId,
    sessionKey: context.pluginSdkSessionKey,
    storeTranscriptEvents,
    transcriptEventsAfterAppend,
    transcriptEventsBeforeAppend,
  };
}

async function runConcurrentMultiClientLifecycle(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  context: ProofContext,
  primaryClient: Awaited<ReturnType<typeof connectGatewayClient>>,
): Promise<void> {
  const historyClient = await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientDisplayName: "sqlite-sessions-transcripts-flip-proof-concurrent-history",
    requestTimeoutMs: 20_000,
    timeoutMs: 20_000,
  });
  const lifecycleClient = await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientDisplayName: "sqlite-sessions-transcripts-flip-proof-concurrent-lifecycle",
    requestTimeoutMs: 20_000,
    timeoutMs: 20_000,
  });
  try {
    const sendPromise = sendGatewayUserMessage(
      primaryClient,
      context.concurrentSendSessionKey,
      CONCURRENT_SEND_TEXT,
    );
    const historyPromise = requireHistoryContains(
      historyClient,
      context.concurrentResetSessionKey,
      "concurrent reset seed",
    );
    const resetPromise = resetSession(lifecycleClient, context.concurrentResetSessionKey);

    const [sendRunId, , resetSessionId] = await Promise.all([
      sendPromise,
      historyPromise,
      resetPromise,
    ]);
    await waitForAgentRunOk(primaryClient, sendRunId);
    const sendSessionId = await waitForSqliteSessionId(
      context.agentDbPath,
      context.concurrentSendSessionKey,
    );
    await waitForSqliteMessageContains(
      context.agentDbPath,
      sendSessionId,
      "user",
      CONCURRENT_SEND_TEXT,
    );
    await waitForSqliteMessageContains(
      context.agentDbPath,
      sendSessionId,
      "assistant",
      context.fullTurnAssistantText,
    );
    await waitForTrackedSessionId(
      context.agentDbPath,
      context.concurrentResetSessionKey,
      resetSessionId,
    );

    const deleteRunId = await sendGatewayUserMessage(
      historyClient,
      context.concurrentDeleteSessionKey,
      CONCURRENT_DELETE_TEXT,
    );
    const deleteHistoryPromise = lifecycleClient.request(
      "chat.history",
      { sessionKey: context.concurrentDeleteSessionKey, limit: 50 },
      { timeoutMs: 20_000 },
    );
    await Promise.all([
      deleteHistoryPromise,
      deleteSession(primaryClient, context.concurrentDeleteSessionKey),
    ]);
    await waitForAgentRunSettled(historyClient, deleteRunId);
    await waitForSessionEntryAbsent(context.agentDbPath, context.concurrentDeleteSessionKey);
  } finally {
    await Promise.all([
      disconnectGatewayClient(historyClient),
      disconnectGatewayClient(lifecycleClient),
    ]);
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

async function waitForAgentRunOk(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  runId: string,
): Promise<void> {
  const result: { error?: unknown; status?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  if (result?.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: ${JSON.stringify(result)}`);
  }
}

async function waitForAgentRunSettled(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  runId: string,
): Promise<void> {
  const result: { endedAt?: number; status?: string; stopReason?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  if (typeof result?.status !== "string") {
    throw new Error(`agent.wait returned no status for ${runId}: ${JSON.stringify(result)}`);
  }
  if (result.status === "ok") {
    return;
  }
  if (
    result.status === "timeout" &&
    (result.stopReason === "rpc" || result.stopReason === "stop") &&
    typeof result.endedAt === "number"
  ) {
    return;
  }
  throw new Error(`agent.wait did not settle acceptably for ${runId}: ${JSON.stringify(result)}`);
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

async function waitForSqliteSessionId(dbPath: string, sessionKey: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey && entry.sessionId,
    );
    if (row?.sessionId) {
      return row.sessionId;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for SQLite session entry for ${sessionKey}`);
}

async function waitForTrackedSessionId(
  dbPath: string,
  sessionKey: string,
  expectedSessionId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey,
    );
    if (row?.sessionId === expectedSessionId) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for SQLite session entry ${sessionKey} to point at ${expectedSessionId}`,
  );
}

async function waitForSessionEntryAbsent(dbPath: string, sessionKey: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let absentSince: number | undefined;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey,
    );
    if (!row) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= 1_500) {
        return;
      }
      await sleep(50);
      continue;
    }
    absentSince = undefined;
    await sleep(50);
  }
  throw new Error(`timed out waiting for SQLite session entry deletion for ${sessionKey}`);
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

async function requireMockOpenAiRequest(requestLogPath: string): Promise<void> {
  const text = await fs.readFile(requestLogPath, "utf8").catch(() => "");
  if (!text.includes('"/v1/responses"')) {
    throw new Error(`mock OpenAI request log did not include /v1/responses: ${tail(text)}`);
  }
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
    legacyStateJsonl: await inventoryActiveJsonl(context.legacySessionsDir),
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
      `SELECT session_key AS sessionKey, session_id AS sessionId, entry_json AS entryJson
       FROM session_entries
       ORDER BY session_key ASC`,
    )
    .all() as Array<{ entryJson?: unknown; sessionId?: unknown; sessionKey?: unknown }>;
  return rows
    .filter(
      (row) =>
        trackedSessionKeys.length === 0 ||
        trackedSessionKeys.includes(typeof row.sessionKey === "string" ? row.sessionKey : ""),
    )
    .map((row) => {
      const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
      return {
        ...(typeof row.entryJson === "string" ? { entry: parseEntryJson(row.entryJson) } : {}),
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

function parseEntryJson(entryJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(entryJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entry = { ...(parsed as Record<string, unknown>) };
    delete entry.skillsSnapshot;
    return entry;
  } catch {
    return undefined;
  }
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
  if (checkpoint.label !== "seeded-legacy-store" && checkpoint.legacyStateJsonl.length > 0) {
    failures.push(
      `${checkpoint.label}: old sessions directory still has JSONL files: ${checkpoint.legacyStateJsonl
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  if (checkpoint.label.startsWith("after-doctor") && checkpoint.doctor?.code !== 0) {
    failures.push(`${checkpoint.label}: doctor ${checkpoint.doctor.mode} exited non-zero`);
  }
  if (
    checkpoint.label === "after-doctor-fix" &&
    (checkpoint.sqlite.sessionEntries === 0 || checkpoint.sqlite.transcriptEvents === 0)
  ) {
    failures.push(`${checkpoint.label}: doctor --fix did not import sessions into SQLite`);
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
      `  activeJsonl=${checkpoint.activeJsonl.length} legacyStateJsonl=${checkpoint.legacyStateJsonl.length} archiveArtifacts=${checkpoint.archiveArtifacts.length}`,
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
