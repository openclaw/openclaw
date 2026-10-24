import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("waits for a delayed EOF exit without forcing the app-server", async () => {
  vi.useFakeTimers();
  const harness = createClientHarness({ autoEmitExit: false });
  Object.assign(harness.process, { pid: process.pid });
  const closing = harness.client.closeAndWait({ forceKillDelayMs: 1_000 });
  await vi.advanceTimersByTimeAsync(500);
  expect(harness.process.kill).not.toHaveBeenCalled();
  harness.emitExit();
  await expect(closing).resolves.toEqual({ exited: true, cleanup: "closed" });
  expect(vi.getTimerCount()).toBe(0);
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
    if (cleanup === "confirmed") {
      expect(warning).toHaveBeenCalledWith(
        "Codex app-server required forced shutdown; process cleanup confirmed",
      );
    } else {
      expect(warning).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
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
    const client = CodexAppServerClient.fromTransportForTests(child);
    const warning = vi.spyOn(embeddedAgentLog, "warn");
    try {
      await client.request("test/ready", {}, { timeoutMs: 5_000 });
      // Shared-client retirement calls close before its owner joins closeAndWait.
      client.close();
      await expect(client.closeAndWait()).resolves.toEqual({ exited: true, cleanup: "closed" });
      await exited;
      expect(child.exitCode).toBe(0);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      child.kill("SIGKILL");
      await exited;
      await client.closeAndWait();
    }
  });
});
