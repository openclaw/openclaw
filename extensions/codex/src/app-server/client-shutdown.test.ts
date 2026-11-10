import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import {
  getOrCreateSharedClientEntry,
  getSharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";
import { clearSharedCodexAppServerClientIfCurrentAndUnclaimed } from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.skipIf(process.platform === "win32")("npm launcher shutdown", () => {
  it.each(["confirmed", "unconfirmed"])("preserves %s force-kill containment", async (cleanup) => {
    vi.useFakeTimers();
    const harness = createClientHarness({ autoEmitExit: false });
    const root = { pid: 12345, ppid: process.pid, pgid: 12345, state: "S", startedAt: "fake" };
    Object.assign(harness.process, { pid: root.pid });
    // Model OS reads/signals; the real containment owner must produce the receipt.
    vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(async () => {
      if (cleanup === "unconfirmed") {
        throw new processSnapshot.ProcessInspectionError("unavailable");
      }
      return [{ ...root }];
    });
    vi.spyOn(processSnapshot, "readCodexAppServerProcess").mockImplementation(async () => ({
      ...root,
    }));
    const signal = (_pid: number, value?: string | number): true => {
      if (value === "SIGSTOP" || value === "SIGCONT") {
        root.state = value === "SIGSTOP" ? "T" : "S";
      }
      if (value === "SIGKILL") {
        harness.process.emit("exit", null, "SIGKILL");
      }
      return true;
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(signal);
    vi.mocked(harness.process.kill).mockImplementation((value) => signal(root.pid, value));
    const warning = vi.spyOn(embeddedAgentLog, "warn");
    const closing = harness.client.closeAndWait({ forceKillDelayMs: 10, exitTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(closing).resolves.toEqual({
      exited: true,
      cleanup: cleanup === "confirmed" ? "terminated" : "uncertain",
    });
    expect(kill).toHaveBeenCalledWith(-root.pid, "SIGKILL");
    expect(warning).toHaveBeenCalledTimes(cleanup === "confirmed" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the requested grace when shared retirement starts shutdown", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness({ autoEmitExit: false });
    Object.assign(harness.process, { pid: 12345 });
    const snapshot = vi
      .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
      .mockRejectedValue(new processSnapshot.ProcessInspectionError("unavailable"));
    const state = getSharedCodexAppServerClientState();
    const entry = getOrCreateSharedClientEntry(state, "delayed-clean-exit");
    entry.client = harness.client;
    state.entriesByClient.set(harness.client, entry);
    const options = { forceKillDelayMs: 5_000, exitTimeoutMs: 6_000 };
    try {
      expect(
        clearSharedCodexAppServerClientIfCurrentAndUnclaimed(harness.client, options).closed,
      ).toBe(true);
      const closing = harness.client.closeAndWait(options);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(snapshot).not.toHaveBeenCalled();
      expect(harness.process.kill).not.toHaveBeenCalled();
      harness.process.emit("exit", 0, null);
      await expect(closing).resolves.toEqual({ exited: true, cleanup: "closed" });
    } finally {
      harness.process.emit("exit", 0, null);
      state.clients.delete(entry.key);
      state.entriesByClient.delete(harness.client);
    }
  });

  it("lets the native server exit through its npm launcher", async () => {
    const root = tempDirs.make("codex-client-shutdown-");
    const nativePath = path.join(root, "native.mjs");
    const launcherPath = path.join(root, "launcher.mjs");
    await fs.writeFile(
      nativePath,
      `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    // Same inherited stdio and exit-signal mirroring as codex-cli/bin/codex.js.
    await fs.writeFile(
      launcherPath,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [process.argv[2]], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
    );
    const child = spawn(process.execPath, [launcherPath, nativePath], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
    const exited = once(child, "exit");
    const client = CodexAppServerClient.fromTransport(child);
    const warning = vi.spyOn(embeddedAgentLog, "warn");
    try {
      await client.request("test/ready", {}, { timeoutMs: 5_000 });
      vi.useFakeTimers();
      // Shared-client retirement calls close before its owner joins closeAndWait.
      client.close();
      const closing = client.closeAndWait();
      await vi.advanceTimersByTimeAsync(500);
      expect(child.killed).toBe(false);
      await expect(closing).resolves.toEqual({ exited: true, cleanup: "closed" });
      await exited;
      expect(child.exitCode).toBe(0);
      expect(warning).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await client.closeAndWait();
    }
  });
});
