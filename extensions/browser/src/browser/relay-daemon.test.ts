import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";

const TOKEN = relayTestKey(1);

const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function stageRelaySecret(token: string | null = TOKEN): Promise<void> {
  const stateDir = tempStateDirs.make("openclaw-relay-daemon-");
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  if (token !== null) {
    await fs.writeFile(path.join(credentialsDir, "browser-extension-relay.secret"), `${token}\n`, {
      mode: 0o600,
    });
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}

it.each([
  [undefined, 401],
  [true, 503],
] as const)("legacy auth opt-in %s returns %s", async (allowLegacyAuth, expected) => {
  await stageRelaySecret();
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
  await stageRelaySecret(null);
  const run = await runExtensionRelayDaemon({ port: 0 });
  expect(run.port).toBeNull();
  await expect(run.done).resolves.toBe("no-credential");
});

it("exits quietly when the relay port is already served", async () => {
  await stageRelaySecret();
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const run = await runExtensionRelayDaemon({ port });
    expect(run.port).toBeNull();
    await expect(run.done).resolves.toBe("port-in-use");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

it("serves the relay until the idle grace elapses with no peers", async () => {
  await stageRelaySecret();
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
