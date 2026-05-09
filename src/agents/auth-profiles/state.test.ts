import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importLegacyAuthProfileStateFileToSqlite } from "../../commands/doctor/legacy/auth-profile-state.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readOpenClawStateKvJson } from "../../state/openclaw-state-kv.js";
import { resolveAuthStatePath } from "./paths.js";
import { loadPersistedAuthProfileState, savePersistedAuthProfileState } from "./state.js";

const AUTH_PROFILE_STATE_KV_SCOPE = "auth-profile-state";

describe("auth profile runtime state persistence", () => {
  let stateRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-state-root-"));
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-state-agent-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("reads runtime state from SQLite without auth-state.json", async () => {
    savePersistedAuthProfileState(
      {
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
        usageStats: { "openai:default": { lastUsed: 123 } },
      },
      agentDir,
    );
    await expect(fs.access(resolveAuthStatePath(agentDir))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(loadPersistedAuthProfileState(agentDir)).toEqual({
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: { "openai:default": { lastUsed: 123 } },
    });
  });

  it("imports legacy auth-state.json into SQLite through the doctor migration helper", async () => {
    const statePath = resolveAuthStatePath(agentDir);
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        order: { anthropic: ["anthropic:default"] },
        lastGood: { anthropic: "anthropic:default" },
      })}\n`,
    );

    expect(loadPersistedAuthProfileState(agentDir)).toEqual({});
    expect(importLegacyAuthProfileStateFileToSqlite(agentDir)).toEqual({ imported: true });
    expect(loadPersistedAuthProfileState(agentDir)).toEqual({
      order: { anthropic: ["anthropic:default"] },
      lastGood: { anthropic: "anthropic:default" },
    });

    const sqliteState = readOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, statePath);
    expect(sqliteState).toMatchObject({
      order: { anthropic: ["anthropic:default"] },
      lastGood: { anthropic: "anthropic:default" },
    });
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes SQLite state when runtime state is empty", async () => {
    savePersistedAuthProfileState(
      {
        usageStats: { "openai:default": { lastUsed: 123 } },
      },
      agentDir,
    );

    expect(savePersistedAuthProfileState({}, agentDir)).toBeNull();

    const statePath = resolveAuthStatePath(agentDir);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, statePath)).toBeUndefined();
  });
});
