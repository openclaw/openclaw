import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";

const lockBasenamePattern = /^lock-[0-9a-f]{32}$/;

describe("resolveOAuthRefreshLockPath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-lock-path-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps lock paths inside the oauth-refresh directory for dot-segment ids", () => {
    const refreshLockDir = path.join(stateDir, "locks", "oauth-refresh");
    const dotSegmentPath = resolveOAuthRefreshLockPath("openai", "..");
    const currentDirPath = resolveOAuthRefreshLockPath("openai", ".");

    expect(path.dirname(dotSegmentPath)).toBe(refreshLockDir);
    expect(path.dirname(currentDirPath)).toBe(refreshLockDir);
    expect(path.basename(dotSegmentPath)).toMatch(lockBasenamePattern);
    expect(path.basename(currentDirPath)).toMatch(lockBasenamePattern);
    expect(path.basename(dotSegmentPath)).not.toBe(path.basename(currentDirPath));
  });

  it("is immune to simple concat collisions at the provider/profile boundary", () => {
    // With a plain `${provider}:${profileId}` hash input, the pair
    // ("a", "b:c") would collide with ("a:b", "c"). Tuple encoding rules that out.
    expect(resolveOAuthRefreshLockPath("a", "b:c")).not.toBe(
      resolveOAuthRefreshLockPath("a:b", "c"),
    );
    expect(resolveOAuthRefreshLockPath("a", "\x00b")).not.toBe(
      resolveOAuthRefreshLockPath("a\x00", "b"),
    );
  });

  it("anchors the lock to an explicitly targeted state directory", () => {
    const first = resolveOAuthRefreshLockPath("openai", "openai:default", {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(stateDir, "first"),
    });
    const second = resolveOAuthRefreshLockPath("openai", "openai:default", {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(stateDir, "second"),
    });

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join(stateDir, "first", "locks", "oauth-refresh"));
    expect(path.dirname(second)).toBe(path.join(stateDir, "second", "locks", "oauth-refresh"));
  });
});
