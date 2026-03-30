import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveOAuthRefreshLockPath } from "./auth-profiles/paths.js";

describe("resolveOAuthRefreshLockPath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-lock-path-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps lock paths inside the oauth-refresh directory for dot-segment ids", () => {
    const refreshLockDir = path.join(stateDir, "locks", "oauth-refresh");
    const dotSegmentPath = resolveOAuthRefreshLockPath("..");
    const currentDirPath = resolveOAuthRefreshLockPath(".");

    expect(path.dirname(dotSegmentPath)).toBe(refreshLockDir);
    expect(path.dirname(currentDirPath)).toBe(refreshLockDir);
    expect(path.basename(dotSegmentPath)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(path.basename(currentDirPath)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(path.basename(dotSegmentPath)).not.toBe(path.basename(currentDirPath));
  });

  it("hashes profile ids so distinct values stay distinct", () => {
    expect(resolveOAuthRefreshLockPath("openai-codex:work/test")).not.toBe(
      resolveOAuthRefreshLockPath("openai-codex_work:test"),
    );
    expect(resolveOAuthRefreshLockPath("«c")).not.toBe(resolveOAuthRefreshLockPath("઼"));
  });

  it("keeps lock filenames short for long profile ids", () => {
    const longProfileId = `openai-codex:${"x".repeat(512)}`;
    const basename = path.basename(resolveOAuthRefreshLockPath(longProfileId));

    expect(basename).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(Buffer.byteLength(basename, "utf8")).toBeLessThan(255);
  });
});
