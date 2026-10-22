import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";

const TOKEN = relayTestKey(1);
let secretPath: string;

const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const stateDir = tempStateDirs.make("openclaw-relay-daemon-");
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  secretPath = path.join(credentialsDir, "browser-extension-relay.secret");
  await fs.writeFile(secretPath, `${TOKEN}\n`, { mode: 0o600 });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

it.each([
  [undefined, 401],
  [true, 503],
] as const)("legacy auth opt-in %s returns %s", async (allowLegacyAuth, expected) => {
  const run = await runExtensionRelayDaemon({ port: 0, allowLegacyAuth });
  try {
    const response = await fetch(`http://127.0.0.1:${run.port}/json/version`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(expected);
  } finally {
    run.stop();
    await run.done;
  }
});

it("refuses to start without a relay credential", async () => {
  await fs.unlink(secretPath);
  const run = await runExtensionRelayDaemon({ port: 0 });
  expect(run.port).toBeNull();
  await expect(run.done).resolves.toBe("no-credential");
});

it("serves the relay until the idle grace elapses with no peers", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const run = await runExtensionRelayDaemon({ port: 0 });
  expect(run.port).toBeGreaterThan(0);
  const served = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: run.port ?? 0 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  expect(served).toBe(true);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  await expect(run.done).resolves.toBe("idle");
});
