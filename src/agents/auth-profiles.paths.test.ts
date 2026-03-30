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
    expect(path.basename(dotSegmentPath)).toBe("utf8-2e2e");
    expect(path.basename(currentDirPath)).toBe("utf8-2e");
  });

  it("encodes full utf8 bytes so distinct profile ids stay distinct", () => {
    expect(resolveOAuthRefreshLockPath("openai-codex:work/test")).not.toBe(
      resolveOAuthRefreshLockPath("openai-codex_work:test"),
    );
    expect(resolveOAuthRefreshLockPath("«c")).not.toBe(resolveOAuthRefreshLockPath("઼"));
  });
});
