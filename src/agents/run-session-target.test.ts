import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSqliteSessionEntry,
  patchSqliteSessionEntry,
} from "../config/sessions/session-accessor.sqlite.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  persistAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "./run-session-target.js";

describe("agent run session target", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-session-target-"));
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves runtime identity through the run config store", async () => {
    const storePath = path.join(tempDir, "custom-sessions", "sessions.json");
    const sessionKey = "agent:helper:commitments:test-run";

    const target = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: storePath } } as OpenClawConfig,
      sessionId: "test-run",
      sessionKey,
    });

    expect(target).toMatchObject({
      agentId: "helper",
      sessionId: "test-run",
      sessionKey,
      targetKind: "runtime-session",
    });
    expect(path.dirname(target.sessionFile)).toBe(path.dirname(storePath));
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]?.sessionFile).toBe(
      target.sessionFile,
    );
  });

  it("uses the agent from an agent-scoped session key when agentId is omitted", async () => {
    const storeRoot = path.join(tempDir, "agents", "{agentId}", "sessions.json");
    const sessionKey = "agent:helper:main";

    const target = await resolveAgentRunSessionTarget({
      config: { session: { store: storeRoot } } as OpenClawConfig,
      sessionId: "helper-session",
      sessionKey,
    });

    const helperStorePath = path.join(tempDir, "agents", "helper", "sessions.json");
    expect(target.agentId).toBe("helper");
    expect(path.dirname(target.sessionFile)).toBe(path.dirname(helperStorePath));
    expect(loadSessionStore(helperStorePath, { skipCache: true })[sessionKey]?.sessionFile).toBe(
      target.sessionFile,
    );
  });

  it("resolves SQLite identity through the persisted active file artifact", async () => {
    const sqlitePath = path.join(tempDir, "helper", "openclaw-agent.sqlite");
    const sessionKey = "agent:helper:commitments:sqlite-run";

    const target = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: sqlitePath } } as OpenClawConfig,
      sessionId: "sqlite-run",
      sessionKey,
    });

    expect(target).toMatchObject({
      activeArtifactKind: "embedded-run-session-file",
      agentId: "helper",
      sessionId: "sqlite-run",
      sessionKey,
      sqlitePath,
      storageKind: "sqlite",
      targetKind: "sqlite-runtime-session",
    });
    expect(path.dirname(target.sessionFile)).toBe(
      path.join(path.dirname(sqlitePath), "embedded-run-session-files"),
    );
    expect(
      loadSqliteSessionEntry({
        agentId: "helper",
        sessionKey,
        storePath: sqlitePath,
      }),
    ).toMatchObject({
      sessionFile: target.sessionFile,
      sessionId: "sqlite-run",
    });

    const rotatedSessionFile = path.join(
      path.dirname(target.sessionFile),
      "2026-06-04T12-00-00-000Z_sqlite-run-compact.jsonl",
    );
    await persistAgentRunSessionTargetIdentity({
      sessionFile: rotatedSessionFile,
      sessionId: "sqlite-run-compact",
      target,
    });

    const rotatedTarget = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: sqlitePath } } as OpenClawConfig,
      sessionId: "sqlite-run-compact",
      sessionKey,
    });

    expect(rotatedTarget).toMatchObject({
      sessionFile: rotatedSessionFile,
      sessionId: "sqlite-run-compact",
      storageKind: "sqlite",
    });

    const nextTarget = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: sqlitePath } } as OpenClawConfig,
      sessionId: "sqlite-run-next",
      sessionKey,
    });

    expect(nextTarget).toMatchObject({
      sessionId: "sqlite-run-next",
      storageKind: "sqlite",
    });
    expect(nextTarget.sessionFile).toContain("sqlite-run-next.jsonl");
    expect(
      loadSqliteSessionEntry({
        agentId: "helper",
        sessionKey,
        storePath: sqlitePath,
      })?.sessionId,
    ).toBe("sqlite-run-next");
    expect(
      loadSqliteSessionEntry({
        agentId: "helper",
        sessionKey,
        storePath: sqlitePath,
      })?.sessionFile,
    ).toBe(nextTarget.sessionFile);
  });

  it("ignores stale SQLite session files outside the active artifact boundary", async () => {
    const sqlitePath = path.join(tempDir, "helper", "openclaw-agent.sqlite");
    const sessionKey = "agent:helper:commitments:sqlite-stale-file";
    const legacySessionFile = path.join(tempDir, "legacy", "session.jsonl");
    await patchSqliteSessionEntry(
      {
        agentId: "helper",
        sessionKey,
        storePath: sqlitePath,
      },
      () => ({
        sessionFile: legacySessionFile,
        sessionId: "sqlite-stale-file",
        updatedAt: Date.now(),
      }),
      {
        fallbackEntry: {
          sessionFile: legacySessionFile,
          sessionId: "sqlite-stale-file",
          updatedAt: Date.now(),
        },
      },
    );

    const target = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: sqlitePath } } as OpenClawConfig,
      sessionId: "sqlite-stale-file",
      sessionKey,
    });

    expect(target.sessionFile).not.toBe(legacySessionFile);
    expect(path.dirname(target.sessionFile)).toBe(
      path.join(path.dirname(sqlitePath), "embedded-run-session-files"),
    );
  });

  it("can force SQLite resolution for canonical agent session stores", async () => {
    const storeRoot = path.join(
      tempDir,
      "state",
      "agents",
      "{agentId}",
      "sessions",
      "sessions.json",
    );
    const sqlitePath = path.join(
      tempDir,
      "state",
      "agents",
      "helper",
      "agent",
      "openclaw-agent.sqlite",
    );
    const sessionKey = "agent:helper:main";

    const target = await resolveAgentRunSessionTarget({
      config: { session: { store: storeRoot } } as OpenClawConfig,
      sessionId: "helper-session",
      sessionKey,
      sessionTarget: { storageKind: "sqlite" },
    });

    expect(target).toMatchObject({
      agentId: "helper",
      sessionId: "helper-session",
      sessionKey,
      sqlitePath,
      storageKind: "sqlite",
    });
    expect(
      loadSqliteSessionEntry({
        agentId: "helper",
        sessionKey,
        storePath: sqlitePath,
      })?.sessionId,
    ).toBe("helper-session");
  });
});
