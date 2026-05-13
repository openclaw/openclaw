import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  resolveAuthProfileStoreAgentDir,
  resolveAuthProfileStoreKey,
  resolveAuthProfileStoreLocationForDisplay,
  resolveOAuthRefreshLockKey,
} from "./path-resolve.js";

// Direct-import sanity tests. These helpers are exercised transitively by the
// wider auth-profile test suite via ESM re-exports through paths.ts, but v8
// coverage does not always attribute those transitive hits back to the
// original function bodies in path-resolve.ts. This file imports each helper
// directly from ./path-resolve.js (bypassing the re-export indirection) and
// calls it at least once so the coverage report is honest about what is and
// isn't tested.

describe("auth profile path helpers (direct-import coverage attribution)", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-direct-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("resolves the auth profile store key from agentDir", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    expect(resolveAuthProfileStoreKey(agentDir)).toBe(agentDir);
  });

  it("resolves the default auth profile store key when agentDir is omitted", () => {
    const resolved = resolveAuthProfileStoreKey();
    expect(resolved.startsWith(stateDir)).toBe(true);
    expect(resolved.endsWith(path.join("agents", "main", "agent"))).toBe(true);
  });

  it("resolves the display location as a SQLite table target", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthProfileStoreLocationForDisplay(agentDir, {
      OPENCLAW_STATE_DIR: stateDir,
    });
    expect(resolved).toContain("openclaw.sqlite#table/auth_profile_stores/");
    expect(resolved).toContain(agentDir);
  });

  it("expands tilde auth profile store agent dirs", () => {
    const tildeAgentDir = "~fake-openclaw-no-expand";
    const resolved = resolveAuthProfileStoreAgentDir(tildeAgentDir);
    expect(resolved.startsWith("~")).toBe(false);
  });

  it("hashes OAuth refresh lock keys without filesystem path material", () => {
    const first = resolveOAuthRefreshLockKey("openai-codex", "default");
    const second = resolveOAuthRefreshLockKey("openai-codex", "default");
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});
