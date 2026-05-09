import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readOpenClawStateKvJson } from "../../state/openclaw-state-kv.js";
import {
  authProfileStateKey,
  loadPersistedAuthProfileState,
  savePersistedAuthProfileState,
} from "./state.js";

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
    await expect(fs.access(path.join(agentDir, "auth-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(loadPersistedAuthProfileState(agentDir)).toEqual({
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: { "openai:default": { lastUsed: 123 } },
    });
  });

  it("deletes SQLite state when runtime state is empty", async () => {
    savePersistedAuthProfileState(
      {
        usageStats: { "openai:default": { lastUsed: 123 } },
      },
      agentDir,
    );

    expect(savePersistedAuthProfileState({}, agentDir)).toBeNull();

    await expect(fs.access(path.join(agentDir, "auth-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      readOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, authProfileStateKey(agentDir)),
    ).toBeUndefined();
  });
});
