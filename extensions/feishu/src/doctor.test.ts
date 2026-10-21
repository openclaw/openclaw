import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as secretRefReadOnly from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  listSessionEntries,
  normalizeSessionDeliveryState,
  type SessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents as readTranscript,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { FeishuConfigSchema, z } from "./config-schema.js";
import { feishuDoctor } from "./doctor.js";

const runFeishuDoctorSequence = feishuDoctor.runConfigSequence!;
const defaultAgentId = "main";
const defaultFeishuSessionKey = "agent:main:feishu:direct:ou_user";
const blankUserMessages = ["", "", ""];

function feishuConfig(
  feishu: z.input<typeof FeishuConfigSchema> = { appId: "cli_xxx", appSecret: "secret_xxx" },
): OpenClawConfig {
  return { channels: { feishu } };
}

function stateDir(): string {
  return process.env.OPENCLAW_STATE_DIR!;
}

function sessionsDir(agentId = "main"): string {
  return path.join(stateDir(), "agents", agentId, "sessions");
}

function storePath(agentId = "main"): string {
  return path.join(sessionsDir(agentId), "sessions.json");
}

const feishuRoute = { channel: "feishu", target: { to: "ou_user", chatType: "direct" as const } };
const delivery = () => normalizeSessionDeliveryState({ route: feishuRoute });
const webhookBase = {
  appId: "cli_test",
  appSecret: "secret_test",
  connectionMode: "webhook" as const,
};

type SeedSessionParams = {
  agentId?: string;
  entry?: Record<string, unknown>;
  sessionKey?: string;
  storePath?: string;
};

async function seedSession(
  sessionId: string,
  contents: string[] = [],
  params: SeedSessionParams = {},
) {
  const agentId = params.agentId ?? defaultAgentId;
  const sessionKey = params.sessionKey ?? defaultFeishuSessionKey;
  const targetStorePath = params.storePath ?? storePath(agentId);
  await upsertSessionEntry({
    agentId,
    storePath: targetStorePath,
    sessionKey,
    entry: { sessionId, updatedAt: Date.now(), ...params.entry } as SessionEntry,
  });
  const session = { agentId, sessionId, sessionKey, storePath: targetStorePath };
  for (const content of contents) {
    await appendSessionTranscriptMessageByIdentity({
      ...session,
      message: { role: "user", content },
    });
  }
  return session;
}

function withAgentDatabase(agentId: string, run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(
    path.join(stateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite"),
  );
  try {
    run(database);
  } finally {
    database.close();
  }
}

function insertRawSessionEntry(sessionKey: string, entry: SessionEntry, agentId = "main"): void {
  withAgentDatabase(agentId, (database) => {
    database
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt ?? 0);
    // This preserved session is healthy; settle the validity projection like the canonical writer.
    database
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);
  });
}

function readStoreEntries(target: string, agentId = "main"): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ agentId, storePath: target }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

function writeLegacyTranscript(sessionId: string, lines: unknown[], agentId = "main"): string {
  const target = path.join(sessionsDir(agentId), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return target;
}

function userMessage(content: string) {
  return {
    type: "message",
    id: `msg-${content || "blank"}-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content },
  };
}

function backupDir(): string {
  const backupsDir = path.join(stateDir(), "backups");
  const backups = fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((name) => name.startsWith("feishu-state-repair-"))
    : [];
  expect(backups).toHaveLength(1);
  return path.join(stateDir(), "backups", backups[0]!);
}

function expectPaths(base: string, paths: Record<string, boolean>) {
  for (const [relative, exists] of Object.entries(paths)) {
    expect(fs.existsSync(path.join(base, relative)), relative).toBe(exists);
  }
}

function expectNotes(notes: string[], ...contents: string[]) {
  for (const content of contents) {
    expect(notes.join("\n")).toContain(content);
  }
}

function writeFeishuDedupState(contents: string): void {
  const target = path.join(stateDir(), "feishu", "dedup", "default.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

async function runDoctor(shouldRepair: boolean, cfg: OpenClawConfig = feishuConfig()) {
  return await runFeishuDoctorSequence({ cfg, env: process.env, shouldRepair });
}

const webhookNotes = (config: z.input<typeof FeishuConfigSchema>) =>
  runDoctor(false, feishuConfig(config));

async function repair(cfg?: OpenClawConfig) {
  const result = await runDoctor(true, cfg);
  expect(result.warningNotes).toEqual([]);
  return result;
}

describe("Feishu doctor state repair", () => {
  let testState: OpenClawTestState | undefined;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-feishu-doctor-",
      layout: "home",
    });
  });

  afterEach(async () => {
    await testState?.cleanup();
    testState = undefined;
  });

  it("repairs SQLite-backed Feishu sessions with corrupt transcript rows", async () => {
    const session = await seedSession("sess-sqlite-corrupt", ["bad row follows"], {
      sessionKey: "agent:main:feishu:direct:ou_sqlite_corrupt",
    });
    withAgentDatabase(session.agentId, (database) => {
      database
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
        .run("{", session.sessionId);
    });
    const result = await repair();
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    expect(readStoreEntries(session.storePath)[session.sessionKey]).toBeUndefined();
  });

  it("warns before repair when Feishu local state is corrupt", async () => {
    writeFeishuDedupState("{");
    const result = await runDoctor(false);

    expect(result.changeNotes).toEqual([]);
    expectNotes(
      result.warningNotes,
      "Feishu local channel state may need repair",
      "preserving Feishu App ID/secret config",
      "openclaw doctor --fix",
    );
  });

  it("rebuilds corrupt Feishu state without deleting healthy Feishu sessions", async () => {
    writeFeishuDedupState("{");
    const session = await seedSession("sess-ok", ["hello"]);

    const result = await repair();
    expectNotes(
      result.changeNotes,
      "Rebuilt Feishu runtime state: yes",
      "Removed 0 Feishu-scoped session entries",
    );

    const store = readStoreEntries(session.storePath);
    expect(store[session.sessionKey]).toBeDefined();
    await expect(readTranscript(session)).resolves.toHaveLength(2);

    expectPaths(stateDir(), { feishu: true, "feishu/dedup/default.json": false });
    expectPaths(backupDir(), {
      "feishu/dedup/default.json": true,
      "session-stores/main/sessions.json": false,
    });
  });

  it("removes only unhealthy Feishu direct sessions while preserving state, config, and other sessions", async () => {
    writeFeishuDedupState(JSON.stringify({ msg1: 1 }));

    const acpTranscriptPath = writeLegacyTranscript("sess-acp-bad", [
      {
        type: "session",
        id: "sess-acp-bad",
        version: 7,
        timestamp: new Date(0).toISOString(),
        cwd: "/tmp",
      },
      ...blankUserMessages.map(userMessage),
    ]);

    const session = await seedSession("sess-bad", blankUserMessages);
    const healthy = await seedSession("sess-separated-blanks", ["", "hello", "", "world", ""], {
      sessionKey: "agent:main:feishu:direct:ou_healthy",
    });
    const canonical = await seedSession("sess-sqlite", [], {
      sessionKey: "agent:main:feishu:direct:ou_canonical",
      entry: { sessionFile: "missing-legacy-transcript.jsonl" },
    });
    const locked = await seedSession("sess-codex-locked", [], {
      sessionKey: "agent:main:ordinary-codex-locked",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        delivery: delivery(),
        updatedAt: 1,
      },
    });
    const targetStorePath = session.storePath;
    fs.mkdirSync(path.dirname(targetStorePath), { recursive: true });
    fs.writeFileSync(targetStorePath, "{}");
    await seedSession("sess-discord", [], {
      storePath: targetStorePath,
      sessionKey: "agent:main:discord:direct:user",
    });
    insertRawSessionEntry("agent:codex:acp:binding:feishu:default:abc123", {
      sessionId: "sess-acp-bad",
      sessionFile: "sess-acp-bad.jsonl",
      updatedAt: Date.now(),
      delivery: delivery(),
    });

    const result = await repair();
    expectNotes(
      result.changeNotes,
      "Feishu local state repaired",
      "Removed 1 Feishu-scoped session entry",
      "Rebuilt Feishu runtime state: not needed",
      "Preserved Feishu App ID/secret config",
    );
    expectPaths(stateDir(), { feishu: true, "feishu/dedup/default.json": true });
    expectPaths(backupDir(), {
      "feishu/dedup/default.json": false,
      "session-stores/main/sessions.json": true,
      "session-stores/main/openclaw-agent.sqlite": true,
    });

    const store = readStoreEntries(targetStorePath);
    expect(store[defaultFeishuSessionKey]).toBeUndefined();
    expect(store["agent:codex:acp:binding:feishu:default:abc123"]).toBeDefined();
    expect(store["agent:main:discord:direct:user"]).toBeDefined();
    for (const preserved of [healthy, canonical, locked]) {
      expect(store[preserved.sessionKey]).toBeDefined();
    }
    await expect(readTranscript(healthy)).resolves.toHaveLength(6);
    await expect(readTranscript(canonical)).resolves.toEqual([]);

    expect(fs.existsSync(acpTranscriptPath)).toBe(true);
    await expect(readTranscript(session)).resolves.toEqual([]);
  });

  it("backs up a live custom SQLite store without sidecars before repairing it", async () => {
    const agentId = "support";
    const target = path.join(stateDir(), "custom-sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      ...feishuConfig(),
      agents: { entries: { [agentId]: {} } },
      session: { store: target },
    };
    const session = await seedSession("sess-migrated-bad", blankUserMessages, {
      agentId,
      sessionKey: `agent:${agentId}:feishu:direct:ou_migrated`,
      storePath: target,
    });
    const healthy = await seedSession("sess-healthy", ["hello"], {
      agentId,
      sessionKey: `agent:${agentId}:feishu:direct:ou_healthy`,
      storePath: target,
    });
    const sqlitePath = path.join(path.dirname(target), "openclaw-agent.support.sqlite");
    expect(fs.existsSync(session.storePath)).toBe(false);
    expect(fs.existsSync(sqlitePath)).toBe(true);

    const walUpdatedAt = Date.now() - 1_000;
    const writer = new DatabaseSync(sqlitePath);
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);");
      await upsertSessionEntry({
        ...healthy,
        entry: { sessionId: healthy.sessionId, updatedAt: walUpdatedAt },
      });
      expect(fs.statSync(`${sqlitePath}-wal`).size).toBeGreaterThan(0);
      expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(true);

      const result = await repair(cfg);
      expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");

      const storeBackup = path.join(backupDir(), "session-stores", session.agentId);
      expect(fs.readdirSync(storeBackup)).toEqual([path.basename(sqlitePath)]);
      const snapshot = new DatabaseSync(path.join(storeBackup, path.basename(sqlitePath)), {
        readOnly: true,
      });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(
          snapshot
            .prepare("SELECT updated_at FROM session_nodes WHERE session_key = ?")
            .get(healthy.sessionKey),
        ).toEqual({ updated_at: walUpdatedAt });
        expect(
          snapshot
            .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
            .get(session.sessionKey),
        ).toEqual({ current_session_id: session.sessionId });
      } finally {
        snapshot.close();
      }
    } finally {
      writer.close();
    }

    expect(
      readStoreEntries(session.storePath, session.agentId)[session.sessionKey],
    ).toBeUndefined();
    await expect(readTranscript(session)).resolves.toEqual([]);
    expect(readStoreEntries(target, agentId)[healthy.sessionKey]).toBeDefined();
    await expect(readTranscript(healthy)).resolves.toHaveLength(2);
  });

  it("archives unhealthy default-scope sessions when metadata identifies Feishu", async () => {
    const session = await seedSession("sess-default-feishu-bad", blankUserMessages, {
      sessionKey: "agent:main:main",
      entry: {
        origin: { provider: "feishu", from: "feishu:ou_user" },
        route: feishuRoute,
      },
    });
    await seedSession("sess-other", [], {
      storePath: session.storePath,
      sessionKey: "agent:main:main-non-feishu",
      entry: { origin: { provider: "discord" } },
    });

    await repair();
    const store = readStoreEntries(session.storePath);
    expect(store[session.sessionKey]).toBeUndefined();
    expect(store["agent:main:main-non-feishu"]).toBeDefined();
    await expect(readTranscript(session)).resolves.toEqual([]);
  });
});

describe("Feishu webhook Doctor notes", () => {
  let testState: OpenClawTestState;
  beforeAll(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-feishu-doctor-notes-",
      layout: "home",
    });
  });
  afterAll(async () => {
    await testState.cleanup();
  });
  it.each([
    { path: "/readyz?tenant=test", reason: "is reserved for Gateway checks", legacy: false },
    { path: "/%61pi/channels/feishu", reason: "requires Gateway authentication", legacy: true },
  ])(
    "explains $path with legacy listener $legacy",
    async ({ path: webhookPath, reason, legacy }) => {
      const result = await webhookNotes({
        ...webhookBase,
        webhookPath,
        legacyWebhook: legacy ? { port: 3000 } : undefined,
      });
      expect(result.infoNotes).toEqual([]);
      expect(result.warningNotes).toEqual([
        expect.stringContaining(`webhookPath ${JSON.stringify(webhookPath)} ${reason}`),
      ]);
      expect(result.warningNotes[0]).toContain("/feishu/events");
      expect(result.warningNotes[0]).toContain("callback");
      expect(result.warningNotes[0]).toContain(
        legacy ? "before removing the legacyWebhook pin" : "startup is blocked",
      );
    },
  );

  it("reports healthy webhook guidance as information and filters inactive transports", async () => {
    const result = await webhookNotes({
      connectionMode: "webhook",
      accounts: {
        active: { appId: "cli_active", appSecret: "secret_active" },
        disabled: { appId: "cli_disabled", appSecret: "secret_disabled", enabled: false },
        websocket: {
          appId: "cli_websocket",
          appSecret: "secret_websocket",
          connectionMode: "websocket",
        },
      },
    });
    expect(result.warningNotes).toEqual([]);
    expect(result.infoNotes).toEqual([expect.stringContaining('Feishu account "active"')]);
    expect(result.infoNotes?.[0]).toContain("Gateway port");
    expect(result.infoNotes?.[0]).toContain("No legacy listener is configured");
  });

  it("describes raw SecretRef webhook config without inspecting credentials", async () => {
    const inspectSecret = vi
      .spyOn(secretRefReadOnly, "canResolveEnvSecretRefInReadOnlyPath")
      .mockImplementation(() => {
        throw new Error("Doctor webhook guidance must not inspect secrets");
      });
    try {
      const result = await webhookNotes({
        appId: "cli_test",
        appSecret: { source: "file", provider: "fixture-file", id: "/app-secret" },
        encryptKey: { source: "env", provider: "fixture-env", id: "FEISHU_DOCTOR_UNUSED_KEY" },
        verificationToken: { source: "exec", provider: "fixture-exec", id: "verification-token" },
        connectionMode: "webhook",
      });
      expect(result.warningNotes).toEqual([]);
      expect(result.infoNotes).toEqual([
        expect.stringContaining("No legacy listener is configured"),
      ]);
      expect(inspectSecret).not.toHaveBeenCalled();
    } finally {
      inspectSecret.mockRestore();
    }
  });

  it("omits webhook notes when the channel is disabled", async () => {
    const result = await webhookNotes({ ...webhookBase, enabled: false });
    expect(result.infoNotes).toEqual([]);
    expect(result.warningNotes).toEqual([]);
  });
});
