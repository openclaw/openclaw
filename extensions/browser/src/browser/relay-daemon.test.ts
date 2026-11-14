import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { BROWSER_RELAY_EXTENSION_SUBPROTOCOL } from "./extension-relay/auth-v2.js";
import { authenticateExtension } from "./extension-relay/relay-http.test-support.js";
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

async function isPortServed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function relayVersionStatus(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  await response.body?.cancel();
  return response.status;
}

/** A paired extension that holds its relay connection and answers heartbeats. */
async function connectExtension(port: number): Promise<WebSocket> {
  const extension = new WebSocket(
    `ws://127.0.0.1:${port}/extension`,
    BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
    { origin: "chrome-extension://relay-daemon-test" },
  );
  try {
    await once(extension, "open");
    await authenticateExtension(extension, TOKEN);
    extension.on("message", (frame) => {
      if ((JSON.parse(rawDataToString(frame)) as { type?: string }).type === "ping") {
        extension.send(JSON.stringify({ type: "pong" }));
      }
    });
    extension.send(
      JSON.stringify({
        type: "hello",
        browserVersion: "Chrome/test",
        userAgent: "relay-daemon-test",
        extensionVersion: "2",
        tabs: [],
      }),
    );
    // Legacy discovery answers 200 only once the relay counts the extension as connected.
    await vi.waitFor(async () => expect(await relayVersionStatus(port)).toBe(200));
    return extension;
  } catch (error) {
    extension.terminate();
    throw error;
  }
}

/** Start a daemon from a staged entry file with a connected extension holding it. */
async function startInstalledDaemonWithExtension() {
  await stageRelaySecret();
  const installationPath = path.join(
    tempStateDirs.make("openclaw-relay-install-"),
    "relay-daemon-entry.js",
  );
  await fs.writeFile(installationPath, "// installation A\n");
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const run = await runExtensionRelayDaemon({
    port: 0,
    // Only so legacy discovery can observe the extension connection; v2 is the default.
    allowLegacyAuth: true,
    installationPath,
  });
  const port = run.port ?? 0;
  try {
    const extension = await connectExtension(port);
    return { run, port, extension, installationPath };
  } catch (error) {
    run.stop();
    await run.done;
    throw error;
  }
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
  await withServer(
    (_req, res) => res.end(),
    async (baseUrl) => {
      const run = await runExtensionRelayDaemon({ port: Number(new URL(baseUrl).port) });
      expect(run.port).toBeNull();
      await expect(run.done).resolves.toBe("port-in-use");
    },
  );
});

it("serves the relay until the idle grace elapses with no peers", async () => {
  await stageRelaySecret();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const run = await runExtensionRelayDaemon({ port: 0 });
  try {
    expect(run.port).toBeGreaterThan(0);
    await expect(isPortServed(run.port ?? 0)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(run.done).resolves.toBe("idle");
  } finally {
    run.stop();
    await run.done;
  }
});

it.each([
  [
    "replaced in place",
    async (file: string) => {
      // An app or package update swaps in new files at the same path.
      await fs.writeFile(`${file}.next`, "// installation B\n");
      await fs.rename(`${file}.next`, file);
    },
  ],
  [
    "rewritten in place",
    async (file: string) => {
      // `cp` over an existing file keeps its inode; the content still changes.
      await fs.writeFile(file, "// installation B, rewritten over A\n");
    },
  ],
  ["removed", async (file: string) => await fs.rm(file)],
])(
  "retires with a connected extension once its installation is %s",
  async (_label, retireInstallation) => {
    const { run, port, extension, installationPath } = await startInstalledDaemonWithExtension();
    const extensionClosed = once(extension, "close");
    try {
      await retireInstallation(installationPath);
      await vi.advanceTimersByTimeAsync(30 * 1000);
      // The port is free for the current installation's native host to spawn its own relay.
      await vi.waitFor(async () => expect(await isPortServed(port)).toBe(false));
      await expect(run.done).resolves.toBe("superseded");
      await extensionClosed;
    } finally {
      extension.terminate();
      run.stop();
      await run.done;
    }
  },
);

it("keeps serving a connected extension while its installation is unchanged", async () => {
  const { run, port, extension } = await startInstalledDaemonWithExtension();
  try {
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await expect(relayVersionStatus(port)).resolves.toBe(200);
    expect(extension.readyState).toBe(WebSocket.OPEN);
    run.stop();
    await expect(run.done).resolves.toBe("stopped");
  } finally {
    extension.terminate();
    run.stop();
    await run.done;
  }
});
