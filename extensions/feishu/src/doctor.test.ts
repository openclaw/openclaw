// Feishu tests cover doctor plugin behavior.
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
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuDoctor } from "./doctor.js";

const runFeishuDoctorSequence = feishuDoctor.runConfigSequence!;
const defaultAgentId = "main";
const defaultFeishuSessionKey = "agent:main:feishu:direct:ou_user";
const blankUserMessages = ["", "", ""];

function feishuConfig(): OpenClawConfig {
  return {
    channels: {
      feishu: {
        appId: "cli_xxx",
        appSecret: "secret_xxx",
      },
    },
  } as OpenClawConfig;
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

function sqliteStorePath(agentId = "main"): string {
  return path.join(stateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
}

type SeedSessionParams = {
  agentId?: string;
  contents?: string[];
  entry?: Record<string, unknown>;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

async function seedSession(params: SeedSessionParams) {
  const agentId = params.agentId ?? defaultAgentId;
  const sessionKey = params.sessionKey ?? defaultFeishuSessionKey;
  const targetStorePath = params.storePath ?? storePath(agentId);
  await upsertSessionEntry({
    agentId,
    storePath: targetStorePath,
    sessionKey,
    entry: {
      sessionId: params.sessionId,
      updatedAt: Date.now(),
      ...params.entry,
    } as SessionEntry,
  });
  if (params.contents) {
    for (const content of params.contents) {
      await appendSessionTranscriptMessageByIdentity({
        agentId,
        sessionId: params.sessionId,
        sessionKey,
        storePath: targetStorePath,
        message: { role: "user", content },
      });
    }
  }
  return { agentId, sessionId: params.sessionId, sessionKey, storePath: targetStorePath };
}

function corruptTranscriptEventJson(agentId: string, sessionId: string): void {
  const database = new DatabaseSync(sqliteStorePath(agentId));
  try {
    database
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
      .run("{", sessionId);
  } finally {
    database.close();
  }
}

function insertRawSessionEntry(sessionKey: string, entry: SessionEntry, agentId = "main"): void {
  const database = new DatabaseSync(sqliteStorePath(agentId));
  try {
    database
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt ?? 0);
    // This preserved session is healthy; settle the validity projection like the canonical writer.
    database
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);
  } finally {
    database.close();
  }
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

function sessionHeader(sessionId: string) {
  return {
    type: "session",
    id: sessionId,
    version: 7,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
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

function listBackupDirs(): string[] {
  const backupsDir = path.join(stateDir(), "backups");
  return fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((name) => name.startsWith("feishu-state-repair-"))
    : [];
}

function writeFeishuDedupState(contents: string): void {
  const target = path.join(stateDir(), "feishu", "dedup", "default.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

async function runDoctor(shouldRepair: boolean, cfg: OpenClawConfig = feishuConfig()) {
  return await runFeishuDoctorSequence({ cfg, env: process.env, shouldRepair });
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

  const healthyStateCases = [
    {
      name: "stays quiet for healthy Feishu state and transcripts",
      arrange: async () => {
        writeFeishuDedupState(JSON.stringify({ msg1: 1 }));
        await seedSession({ sessionId: "sess-ok", contents: ["hello"] });
        return feishuConfig();
      },
    },
    {
      name: "keeps custom-store sessions with canonical transcript events",
      arrange: async () => {
        const customStorePath = path.join(stateDir(), "custom-sessions", "sessions.json");
        await seedSession({
          sessionId: "sess-abs",
          storePath: customStorePath,
          contents: ["hello"],
        });
        return {
          ...feishuConfig(),
          session: { store: customStorePath },
        } as OpenClawConfig;
      },
    },
    {
      name: "does not fall back to legacy files for canonical Feishu session rows",
      arrange: async () => {
        await seedSession({
          sessionId: "sess-sqlite",
          entry: { sessionFile: "missing-legacy-transcript.jsonl" },
        });
        return feishuConfig();
      },
    },
  ];

  it.each(healthyStateCases)("$name", async ({ arrange }) => {
    const result = await runDoctor(false, await arrange());

    expect(result).toEqual({ changeNotes: [], infoNotes: [], warningNotes: [] });
  });

  it("repairs SQLite-backed Feishu sessions with corrupt transcript rows", async () => {
    const session = await seedSession({
      sessionId: "sess-sqlite-corrupt",
      sessionKey: "agent:main:feishu:direct:ou_sqlite_corrupt",
      contents: ["bad row follows"],
    });
    corruptTranscriptEventJson(session.agentId, session.sessionId);
    const result = await runDoctor(true);

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    expect(readStoreEntries(session.storePath)[session.sessionKey]).toBeUndefined();
  });

  it("keeps Feishu sessions with separated blank user messages", async () => {
    await seedSession({
      sessionId: "sess-separated-blanks",
      contents: ["", "hello", "", "world", ""],
    });

    const result = await runDoctor(false);

    expect(result).toEqual({ changeNotes: [], infoNotes: [], warningNotes: [] });
  });

  it("warns before repair when Feishu local state is corrupt", async () => {
    writeFeishuDedupState("{");
    const result = await runDoctor(false);

    expect(result.changeNotes).toEqual([]);
    expect(result.warningNotes.join("\n")).toContain("Feishu local channel state may need repair");
    expect(result.warningNotes.join("\n")).toContain("preserving Feishu App ID/secret config");
    expect(result.warningNotes.join("\n")).toContain("openclaw doctor --fix");
  });

  it("rebuilds corrupt Feishu state without deleting healthy Feishu sessions", async () => {
    writeFeishuDedupState("{");
    const session = await seedSession({
      sessionId: "sess-ok",
      contents: ["hello"],
    });

    const result = await runDoctor(true);

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Rebuilt Feishu runtime state: yes");
    expect(result.changeNotes.join("\n")).toContain("Removed 0 Feishu-scoped session entries");

    const store = readStoreEntries(session.storePath);
    expect(store[session.sessionKey]).toBeDefined();
    await expect(readSessionTranscriptEvents(session)).resolves.toHaveLength(2);

    expect(fs.existsSync(path.join(stateDir(), "feishu"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir(), "feishu", "dedup", "default.json"))).toBe(false);

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "feishu", "dedup", "default.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "session-stores", "main", "sessions.json"))).toBe(
      false,
    );
  });

  it("removes only unhealthy Feishu direct sessions while preserving state, config, and other sessions", async () => {
    writeFeishuDedupState(JSON.stringify({ msg1: 1 }));

    const acpTranscriptPath = writeLegacyTranscript("sess-acp-bad", [
      sessionHeader("sess-acp-bad"),
      userMessage(""),
      userMessage(""),
      userMessage(""),
    ]);

    const session = await seedSession({
      sessionId: "sess-bad",
      contents: blankUserMessages,
    });
    const targetStorePath = session.storePath;
    fs.mkdirSync(path.dirname(targetStorePath), { recursive: true });
    fs.writeFileSync(targetStorePath, "{}");
    await upsertSessionEntry({
      agentId: defaultAgentId,
      storePath: targetStorePath,
      sessionKey: "agent:main:discord:direct:user",
      entry: {
        sessionId: "sess-discord",
        updatedAt: Date.now(),
      },
    });
    insertRawSessionEntry("agent:codex:acp:binding:feishu:default:abc123", {
      sessionId: "sess-acp-bad",
      sessionFile: "sess-acp-bad.jsonl",
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({
        route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
      }),
    });

    const result = await runDoctor(true);

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Feishu local state repaired");
    expect(result.changeNotes.join("\n")).toContain("Rebuilt Feishu runtime state: not needed");
    expect(result.changeNotes.join("\n")).toContain("Preserved Feishu App ID/secret config");

    expect(fs.existsSync(path.join(stateDir(), "feishu"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir(), "feishu", "dedup", "default.json"))).toBe(true);

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "feishu", "dedup", "default.json"))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "session-stores", "main", "sessions.json"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(backupDir, "session-stores", "main", "openclaw-agent.sqlite")),
    ).toBe(true);

    const store = readStoreEntries(targetStorePath);
    expect(store[defaultFeishuSessionKey]).toBeUndefined();
    expect(store["agent:codex:acp:binding:feishu:default:abc123"]).toBeDefined();
    expect(store["agent:main:discord:direct:user"]).toBeDefined();

    expect(fs.existsSync(acpTranscriptPath)).toBe(true);
    await expect(readSessionTranscriptEvents(session)).resolves.toEqual([]);
  });

  it("preserves locked harness sessions while repairing ordinary Feishu sessions", async () => {
    const targetStorePath = storePath();
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey: "agent:main:ordinary-codex-locked",
      entry: {
        sessionId: "sess-codex-locked",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        delivery: normalizeSessionDeliveryState({
          route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
        }),
        updatedAt: 1,
      },
    });
    await seedSession({
      sessionId: "sess-feishu-bad",
      storePath: targetStorePath,
      entry: { updatedAt: 1 },
      contents: blankUserMessages,
    });

    const result = await runDoctor(true);

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    const store = readStoreEntries(targetStorePath);
    expect(store["agent:main:ordinary-codex-locked"]).toBeDefined();
    expect(store[defaultFeishuSessionKey]).toBeUndefined();
  });

  const sessionBackupCases = [
    {
      name: "backs up SQLite session stores before removing migrated Feishu sessions",
      arrange: async () => {
        const session = await seedSession({
          sessionId: "sess-migrated-bad",
          sessionKey: "agent:main:feishu:direct:ou_migrated",
          contents: blankUserMessages,
        });
        return {
          cfg: feishuConfig(),
          session,
          sqlitePath: sqliteStorePath(),
          verifyTranscript: false,
        };
      },
    },
    {
      name: "backs up and repairs Feishu sessions in an agent-scoped custom SQLite store",
      arrange: async () => {
        const agentId = "support";
        const customStorePath = path.join(stateDir(), "custom-sessions", "sessions.json");
        const session = await seedSession({
          agentId,
          sessionId: "sess-support-bad",
          sessionKey: "agent:support:feishu:direct:ou_migrated",
          storePath: customStorePath,
          contents: blankUserMessages,
        });
        return {
          cfg: {
            ...feishuConfig(),
            agents: { list: [{ id: agentId, default: true }] },
            session: { store: customStorePath },
          } as OpenClawConfig,
          session,
          sqlitePath: path.join(path.dirname(customStorePath), "openclaw-agent.support.sqlite"),
          verifyTranscript: true,
        };
      },
    },
  ];

  it.each(sessionBackupCases)("$name", async ({ arrange }) => {
    const { cfg, session, sqlitePath, verifyTranscript } = await arrange();
    expect(fs.existsSync(session.storePath)).toBe(false);
    expect(fs.existsSync(sqlitePath)).toBe(true);

    const result = await runDoctor(true, cfg);

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(
      fs.existsSync(path.join(backupDir, "session-stores", session.agentId, "sessions.json")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(backupDir, "session-stores", session.agentId, path.basename(sqlitePath)),
      ),
    ).toBe(true);

    expect(
      readStoreEntries(session.storePath, session.agentId)[session.sessionKey],
    ).toBeUndefined();
    if (verifyTranscript) {
      await expect(readSessionTranscriptEvents(session)).resolves.toEqual([]);
    }
  });

  it("archives unhealthy default-scope sessions when metadata identifies Feishu", async () => {
    const session = await seedSession({
      sessionId: "sess-default-feishu-bad",
      sessionKey: "agent:main:main",
      entry: {
        origin: { provider: "feishu", from: "feishu:ou_user" },
        route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
      },
      contents: blankUserMessages,
    });
    await seedSession({
      sessionId: "sess-other",
      storePath: session.storePath,
      sessionKey: "agent:main:main-non-feishu",
      entry: {
        origin: { provider: "discord" },
      },
    });

    const result = await runDoctor(true);

    expect(result.warningNotes).toEqual([]);
    const store = readStoreEntries(session.storePath);
    expect(store[session.sessionKey]).toBeUndefined();
    expect(store["agent:main:main-non-feishu"]).toBeDefined();
    await expect(readSessionTranscriptEvents(session)).resolves.toEqual([]);
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
  it.each(
    [
      { path: "/readyz?tenant=test", reason: "is reserved for Gateway probes" },
      { path: "/%61pi/channels/feishu", reason: "requires Gateway authentication" },
    ].flatMap((route) =>
      [false, true].map((legacy) => ({ path: route.path, reason: route.reason, legacy })),
    ),
  )(
    "explains $path with legacy listener $legacy",
    async ({ path: webhookPath, reason, legacy }) => {
      const result = await runFeishuDoctorSequence({
        cfg: {
          channels: {
            feishu: {
              appId: "cli_test",
              appSecret: "secret_test",
              connectionMode: "webhook",
              webhookPath,
              legacyWebhook: legacy ? undefined : false,
            },
          },
        },
        shouldRepair: false,
        env: process.env,
      });
      expect(result.infoNotes).toEqual([]);
      expect(result.warningNotes).toEqual([
        expect.stringContaining(`webhookPath ${JSON.stringify(webhookPath)} ${reason}`),
      ]);
      expect(result.warningNotes[0]).toContain("/feishu/events");
      expect(result.warningNotes[0]).toContain("callback");
      expect(result.warningNotes[0]).toContain(
        legacy ? "before setting legacyWebhook:false" : "startup is blocked",
      );
    },
  );

  it("reports healthy webhook guidance as information and filters inactive transports", async () => {
    const result = await runFeishuDoctorSequence({
      cfg: {
        channels: {
          feishu: {
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
          },
        },
      },
      env: process.env,
      shouldRepair: false,
    });
    expect(result.warningNotes).toEqual([]);
    expect(result.infoNotes).toEqual([expect.stringContaining('Feishu account "active"')]);
    expect(result.infoNotes?.[0]).toContain("127.0.0.1:3000");
    expect(result.infoNotes?.[0]).toContain("legacyWebhook:false");
  });

  it("describes raw SecretRef webhook config without inspecting credentials", async () => {
    const inspectSecret = vi
      .spyOn(secretRefReadOnly, "canResolveEnvSecretRefInReadOnlyPath")
      .mockImplementation(() => {
        throw new Error("Doctor webhook guidance must not inspect secrets");
      });
    try {
      const result = await runFeishuDoctorSequence({
        cfg: {
          channels: {
            feishu: {
              appId: "cli_test",
              appSecret: { source: "file", provider: "fixture-file", id: "/app-secret" },
              encryptKey: {
                source: "env",
                provider: "fixture-env",
                id: "FEISHU_DOCTOR_UNUSED_KEY",
              },
              verificationToken: {
                source: "exec",
                provider: "fixture-exec",
                id: "verification-token",
              },
              connectionMode: "webhook",
            },
          },
        },
        env: process.env,
        shouldRepair: false,
      });
      expect(result.warningNotes).toEqual([]);
      expect(result.infoNotes).toEqual([expect.stringContaining("127.0.0.1:3000")]);
      expect(inspectSecret).not.toHaveBeenCalled();
    } finally {
      inspectSecret.mockRestore();
    }
  });

  it("omits webhook notes when the channel is disabled", async () => {
    const result = await runFeishuDoctorSequence({
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
            connectionMode: "webhook",
            enabled: false,
          },
        },
      },
      env: process.env,
      shouldRepair: false,
    });
    expect(result.infoNotes).toEqual([]);
    expect(result.warningNotes).toEqual([]);
  });
});
