import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import {
  awaitGateBeforeSettlement,
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test-support/process.test-support.js";
import { startTunnel } from "./tunnel.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// Ngrok stop can finish its bounded close wait before the OS has reaped the process.
async function expectProcessExit(pidPath: string, signal: AbortSignal): Promise<void> {
  const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  while (isProcessAlive(pid)) {
    signal.throwIfAborted();
    await waitForProcessTick(10, undefined, { signal });
  }
  expect(isProcessAlive(pid)).toBe(false);
}

async function withNgrok(
  script: string,
  run: (paths: { pidPath: string; signalPath: string; evidencePath: string }) => Promise<void>,
): Promise<void> {
  await withTempDir("openclaw-ngrok-", async (tempDir) => {
    const paths = {
      pidPath: path.join(tempDir, "ngrok.pid"),
      signalPath: path.join(tempDir, "ngrok.signal"),
      evidencePath: path.join(tempDir, "ngrok-auth-evidence.json"),
    };
    await fs.writeFile(
      path.join(tempDir, "ngrok.mjs"),
      // Publish the PID before stdout, and readiness after signal handlers are installed.
      `#!/usr/bin/env node
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
const paths = ${JSON.stringify(paths)};
fs.writeFileSync(paths.pidPath, String(process.pid));
${script}
sendReceipt(paths.pidPath, "ready");
setInterval(() => {}, 1000);`,
      { mode: 0o755 },
    );
    await fs.symlink("ngrok.mjs", path.join(tempDir, "ngrok"));
    await withEnvAsync(
      { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
      async () => {
        try {
          await run(paths);
        } finally {
          const pid = Number.parseInt(await fs.readFile(paths.pidPath, "utf8").catch(() => ""), 10);
          if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
            await expect
              .poll(() => isProcessAlive(pid), { timeout: 1_000, interval: 20 })
              .toBe(false)
              .catch(() => {});
          }
        }
      },
    );
  });
}

async function startNgrok(ngrokAuthToken?: string) {
  const tunnel = await startTunnel({
    provider: "ngrok",
    port: 3334,
    path: "/voice/webhook",
    ngrokAuthToken,
  });
  return tunnel ?? Promise.reject(new Error("Expected ngrok tunnel to start"));
}

const announceTunnel =
  'process.stdout.write(JSON.stringify({ msg: "started tunnel", url: "https://bounded.ngrok.test" }) + "\\n");';

describe.skipIf(process.platform === "win32")("voice-call tunnel child process", () => {
  it("passes ngrok auth through the environment without exposing it in argv", async () => {
    await withNgrok(
      `const token = process.env.NGROK_AUTHTOKEN;
fs.writeFileSync(paths.evidencePath, JSON.stringify({ argvContainsToken: process.argv.includes(token), envHasToken: token === "synthetic-test-token" }));
${announceTunnel}`,
      async ({ evidencePath }) => {
        const tunnel = await startNgrok("synthetic-test-token");
        try {
          expect(JSON.parse(await fs.readFile(evidencePath, "utf8"))).toEqual({
            argvContainsToken: false,
            envHasToken: true,
          });
        } finally {
          await tunnel.stop();
        }
      },
    );
  });

  it("force-kills ngrok when it ignores graceful shutdown", async ({ signal }) => {
    await withNgrok(`process.on("SIGTERM", () => {});\n${announceTunnel}`, async ({ pidPath }) => {
      const tunnel = await startNgrok();
      await tunnel.stop();
      await expectProcessExit(pidPath, signal);
    });
  });

  it("force-kills ngrok before rejecting a startup timeout", async ({ signal }) => {
    await withNgrok(
      'process.on("SIGTERM", () => fs.writeFileSync(paths.signalPath, "SIGTERM"));',
      async ({ pidPath, signalPath }) => {
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const result = startNgrok();
        // Observe setup failures while waiting for the child's readiness receipt.
        void result.catch(() => undefined);
        const [callback, delay] = timeoutSpy.mock.calls[0] ?? [];
        const timer = timeoutSpy.mock.results[0];
        timeoutSpy.mockRestore();
        expect(delay).toBe(30_000);
        if (typeof callback !== "function" || timer?.type !== "return") {
          throw new Error("Expected a native ngrok startup deadline");
        }
        await withinTest(
          // This fixture emits no ready stdout; only the test triggers startup settlement.
          awaitGateBeforeSettlement(
            receipts.waitFor(pidPath, "ready"),
            result,
            "ngrok settled before publishing its PID",
          ),
          signal,
        );
        // Advance only startup readiness; real signal escalation and child closure stay timed.
        clearTimeout(timer.value);
        callback();
        await expect(result).rejects.toThrow("ngrok startup timed out (30s)");
        // Timeout rejection follows the termination owner, including its SIGTERM handler.
        expect(await fs.readFile(signalPath, "utf8")).toBe("SIGTERM");
        await expectProcessExit(pidPath, signal);
      },
    );
  }, 40_000);
});
