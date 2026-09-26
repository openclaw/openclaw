import fs from "node:fs/promises";
import path from "node:path";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { startTunnel } from "./tunnel.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidPath: string): Promise<number> {
  let pid = Number.NaN;
  await expect
    .poll(
      async () => {
        try {
          pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
          return Number.isInteger(pid) && pid > 0;
        } catch {
          return false;
        }
      },
      { timeout: 2_000, interval: 20 },
    )
    .toBe(true);
  return pid;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(() => isProcessAlive(pid), { timeout: timeoutMs, interval: 20 }).toBe(false);
    return true;
  } catch {
    return false;
  }
}

async function withNgrok(
  script: string[],
  run: (paths: { pidPath: string; signalPath: string; evidencePath: string }) => Promise<void>,
): Promise<void> {
  await withTempDir("openclaw-ngrok-", async (tempDir) => {
    const paths = {
      pidPath: path.join(tempDir, "ngrok.pid"),
      signalPath: path.join(tempDir, "ngrok.signal"),
      evidencePath: path.join(tempDir, "ngrok-auth-evidence.json"),
    };
    await fs.writeFile(
      path.join(tempDir, "ngrok"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        ...script,
        "fs.writeFileSync(process.env.OPENCLAW_NGROK_PID_FILE, String(process.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    await withEnvAsync(
      {
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_NGROK_PID_FILE: paths.pidPath,
        OPENCLAW_NGROK_SIGNAL_FILE: paths.signalPath,
        OPENCLAW_NGROK_AUTH_EVIDENCE_FILE: paths.evidencePath,
      },
      async () => {
        try {
          await run(paths);
        } finally {
          const pid = Number.parseInt(await fs.readFile(paths.pidPath, "utf8").catch(() => ""), 10);
          if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
            await waitForProcessExit(pid, 1_000);
          }
        }
      },
    );
  });
}

const startNgrok = (ngrokAuthToken?: string) =>
  startTunnel({ provider: "ngrok", port: 3334, path: "/voice/webhook", ngrokAuthToken });

const announceTunnel =
  'process.stdout.write(JSON.stringify({ msg: "started tunnel", url: "https://bounded.ngrok.test" }) + "\\n");';

describe.skipIf(process.platform === "win32")("voice-call tunnel child process", () => {
  it("passes ngrok auth through the environment without exposing it in argv", async () => {
    await withNgrok(
      [
        "const token = process.env.NGROK_AUTHTOKEN;",
        "fs.writeFileSync(",
        "  process.env.OPENCLAW_NGROK_AUTH_EVIDENCE_FILE,",
        '  JSON.stringify({ argvContainsToken: process.argv.includes(token), envHasToken: token === "synthetic-test-token" }),',
        ");",
        announceTunnel,
      ],
      async ({ evidencePath }) => {
        const tunnel = await startNgrok("synthetic-test-token");
        if (!tunnel) {
          throw new Error("Expected ngrok tunnel to start");
        }
        try {
          await expect
            .poll(async () => JSON.parse(await fs.readFile(evidencePath, "utf8")), {
              timeout: 2_000,
              interval: 20,
            })
            .toEqual({ argvContainsToken: false, envHasToken: true });
        } finally {
          await tunnel.stop();
        }
      },
    );
  });

  it("force-kills ngrok when it ignores graceful shutdown", async () => {
    await withNgrok(['process.on("SIGTERM", () => {});', announceTunnel], async ({ pidPath }) => {
      const tunnel = await startNgrok();
      if (!tunnel) {
        throw new Error("Expected ngrok tunnel to start");
      }
      const childPid = await readPid(pidPath);
      await tunnel.stop();
      expect(await waitForProcessExit(childPid, 1_000)).toBe(true);
    });
  });

  it("force-kills ngrok before rejecting a startup timeout", async () => {
    await withNgrok(
      [
        'process.on("SIGTERM", () => fs.writeFileSync(process.env.OPENCLAW_NGROK_SIGNAL_FILE, "SIGTERM"));',
      ],
      async ({ pidPath, signalPath }) => {
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        let result: ReturnType<typeof startTunnel>;
        let timeoutCalls: typeof timeoutSpy.mock.calls;
        let timeoutResults: typeof timeoutSpy.mock.results;
        try {
          result = startNgrok();
          // Keep setup failures from leaving an unobserved startup rejection.
          void result.catch(() => undefined);
          timeoutCalls = [...timeoutSpy.mock.calls];
          timeoutResults = [...timeoutSpy.mock.results];
          const timer = timeoutResults[0];
          if (timer?.type === "return") {
            startupTimer = timer.value;
          }
        } finally {
          timeoutSpy.mockRestore();
        }
        const childPid = await readPid(pidPath);

        expect(timeoutCalls).toEqual([[expect.any(Function), 30_000]]);
        const callback = timeoutCalls[0]?.[0];
        expect(timeoutResults).toHaveLength(1);
        if (typeof callback !== "function" || !startupTimer) {
          throw new Error("Expected one native ngrok startup deadline");
        }
        // Advance only startup readiness; real signal escalation and child closure stay timed.
        clearTimeout(startupTimer);
        callback();
        await expect(result).rejects.toThrow("ngrok startup timed out (30s)");
        await expect
          .poll(
            async () => {
              try {
                return await fs.readFile(signalPath, "utf8");
              } catch {
                return "";
              }
            },
            { timeout: 1_000, interval: 20 },
          )
          .toBe("SIGTERM");
        expect(await waitForProcessExit(childPid, 1_000)).toBe(true);
      },
    );
  }, 40_000);
});
