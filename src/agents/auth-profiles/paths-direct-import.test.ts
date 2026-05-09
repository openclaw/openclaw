import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
} from "./path-resolve.js";

// Direct-import sanity tests. These helpers are exercised transitively by the
// wider auth-profile test suite via ESM re-exports through paths.ts, but v8
// coverage does not always attribute those transitive hits back to the
// original function bodies in path-resolve.ts. This file imports each helper
// directly from ./path-resolve.js (bypassing the re-export indirection) and
// calls it at least once so the coverage report is honest about what is and
// isn't tested.

describe("path-resolve helpers (direct-import coverage attribution)", () => {
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

  it("resolveAuthStorePath joins agentDir with the auth-profiles filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
    expect(path.basename(resolved)).toMatch(/auth-profiles/);
  });

  it("resolveAuthStorePath falls back to the default agent dir when agentDir is omitted", () => {
    // Omitting agentDir exercises the default agent-dir branch. With
    // OPENCLAW_STATE_DIR set to our tempdir, the resolved path must live under it.
    const resolved = resolveAuthStorePath();
    expect(resolved.startsWith(stateDir)).toBe(true);
    expect(path.basename(resolved)).toMatch(/auth-profiles/);
  });

  it("resolveAuthStatePath joins agentDir with the auth-state filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
  });

  it("resolveAuthStatePath falls back to the default agent dir", () => {
    const resolved = resolveAuthStatePath();
    expect(resolved.startsWith(stateDir)).toBe(true);
  });

  it("resolveAuthStorePathForDisplay returns the resolved path for a non-tilde input", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePathForDisplay(agentDir);
    expect(resolved.startsWith(stateDir)).toBe(true);
  });

  it("resolveAuthStorePathForDisplay preserves a tilde-rooted path unchanged", () => {
    // Exercises the `pathname.startsWith(\"~\")` branch. We use a contrived
    // agentDir that already starts with `~` so the resolver echoes the
    // tilde path back instead of expanding it via resolveUserPath.
    const tildeAgentDir = "~fake-openclaw-no-expand";
    const resolved = resolveAuthStorePathForDisplay(tildeAgentDir);
    expect(resolved).toBe(path.resolve(tildeAgentDir, "auth-profiles.json"));
  });

  it("resolveAuthStatePathForDisplay returns the auth-state path for a non-tilde input", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePathForDisplay(agentDir);
    expect(resolved).toBe(path.join(agentDir, "auth-state.json"));
  });
});
