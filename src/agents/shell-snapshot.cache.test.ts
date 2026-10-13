import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";

vi.mock("node:fs", () => ({ statSync: vi.fn(() => ({ mtimeMs: 0, size: 0 })) }));
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(() => Promise.resolve({ mtimeMs: Date.now() })),
    access: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../process/spawn-utils.js", () => ({
  spawnProcess: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }),
}));

describe.skipIf(process.platform === "win32")("shell snapshot cache", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/synthetic/snapshot-home");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/snapshot-state");
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("bounds retained keys while keeping an actively used snapshot cached", async () => {
    const wrap = (cwd: string) =>
      maybeWrapCommandWithShellSnapshot({
        command: "echo cached",
        shell: "/bin/bash",
        shellArgs: ["-c"],
        cwd,
        env: {},
      });
    const active = await wrap("/synthetic/active");
    expect(active).toContain("shell-snapshots/");

    const distinctKeys = 256;
    for (let i = 0; i < distinctKeys; i++) {
      expect(await wrap(`/synthetic/cwd-${i}`)).toContain("shell-snapshots/");
      const loads = vi.mocked(fs.mkdir).mock.calls.length;
      expect(await wrap("/synthetic/active")).toBe(active);
      expect(fs.mkdir).toHaveBeenCalledTimes(loads);
    }

    // Read newest first so probing a miss cannot evict an uncounted retained key.
    let retained = 1;
    for (let i = distinctKeys - 1; i >= 0; i--) {
      const loads = vi.mocked(fs.mkdir).mock.calls.length;
      expect(await wrap(`/synthetic/cwd-${i}`)).toContain("shell-snapshots/");
      if (vi.mocked(fs.mkdir).mock.calls.length === loads) {
        retained++;
      }
    }
    expect(retained).toBe(128);
  });
});
