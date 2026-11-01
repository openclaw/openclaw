import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { acquireTestPortBlock, withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { startBrowserControlServiceFromConfig } from "../control-service.js";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";
import { BROWSER_RELAY_EXTENSION_SUBPROTOCOL } from "./extension-relay/auth-v2.js";
import { authenticateExtension } from "./extension-relay/relay-http.test-support.js";

afterEach(clearRuntimeConfigSnapshot);

async function expectClosed(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port });
  try {
    await expect(once(socket, "connect")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  } finally {
    socket.destroy();
  }
}

it.each(["extension", "openclaw"] as const)(
  "starts only configured extension relays with HTTP control (chrome driver=%s)",
  async (driver) => {
    const claim = await acquireTestPortBlock({ offsets: [0, 2, 10, 11] });
    const controlPort = claim.port + 2;
    const relayPort = claim.port + 10;
    const token = relayTestKey(7);
    try {
      await withTempDir("browser-http-relay-", async (dir) => {
        const credentials = path.join(dir, "credentials");
        const secret = path.join(credentials, "browser-extension-relay.secret");
        if (driver === "extension") {
          await fs.mkdir(credentials);
          await fs.writeFile(secret, token, { mode: 0o600 });
        }
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: dir,
            OPENCLAW_OAUTH_DIR: credentials,
            OPENCLAW_GATEWAY_PORT: String(claim.port),
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
          },
          async () => {
            const config = {
              gateway: { port: claim.port, auth: { mode: "token" as const, token: "test-http" } },
              browser: { profiles: { chrome: { driver, cdpPort: relayPort } } },
            };
            setRuntimeConfigSnapshot(config, config);
            try {
              for (const adoptService of [false, true]) {
                if (adoptService) {
                  await startBrowserControlServiceFromConfig();
                }
                const state = expectDefined(await startBrowserControlServerFromConfig(), "runtime");
                expect(await startBrowserControlServerFromConfig()).toBe(state);
                expect(state.server?.listening).toBe(true);
                if (driver === "extension") {
                  // Authenticate before any browser route/tool call, including after restart.
                  const extension = new WebSocket(
                    `ws://127.0.0.1:${relayPort}/extension`,
                    BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
                    { origin: "chrome-extension://http-startup-test" },
                  );
                  try {
                    await once(extension, "open");
                    await authenticateExtension(extension, token);
                  } finally {
                    extension.terminate();
                  }
                  expect(await fs.readFile(secret, "utf8")).toBe(token);
                } else {
                  await expectClosed(relayPort);
                  await expect(fs.stat(secret)).rejects.toMatchObject({ code: "ENOENT" });
                }
                await stopBrowserControlServer();
                await expectClosed(relayPort);
                await expectClosed(controlPort);
              }
            } finally {
              await stopBrowserControlServer();
            }
          },
        );
      });
    } finally {
      await claim.release();
    }
  },
);
