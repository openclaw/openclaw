import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePairingString } from "../../../chrome-extension/modules/relay-core.js";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { buildBrowserExtensionPairing } from "../extension-pairing.js";
import { getGatewayExtensionRelayModule } from "../extension-relay.runtime.js";
import { runExtensionRelayDaemon } from "../relay-daemon.js";
import { getFreePort } from "../test-port.js";
import { BROWSER_RELAY_EXTENSION_SUBPROTOCOL } from "./auth-v2.js";
import { authenticateExtension, authenticateRelayHttp } from "./relay-coexistence.test-support.js";
import { RawHttpConnection } from "./relay-http.test-support.js";

const getPluginRuntimeGatewayRequestScopeMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => getPluginRuntimeGatewayRequestScopeMock(),
}));

const RELAY_KEY = relayTestKey(8);
const chromeProfile = () => createBrowserControlContext().forProfile("chrome");
const GATEWAY_AUTH = { mode: "token" as const, token: "gateway-integration-test" };
const INVENTORY = {
  type: "tabs",
  tabs: [
    { tabId: 7, url: "https://example.test/initial", title: "Coalesced inventory", active: true },
  ],
};
const EXTENSION_HELLO = {
  type: "hello",
  userAgent: "gateway-wakeup-test",
  browserVersion: "Chrome/test",
  extensionVersion: "2",
  tabs: [],
};

async function relayInventory(port: number): Promise<unknown> {
  const connection = await RawHttpConnection.connect(port);
  try {
    const request = await authenticateRelayHttp(connection, RELAY_KEY, "json-list");
    return await request("/json/list");
  } finally {
    connection.close();
  }
}

function encodeUpgradeHead(messages: object[]): Buffer {
  return Buffer.concat(
    messages.map((message) => {
      const payload = Buffer.from(JSON.stringify(message));
      const extended = payload.length >= 126;
      const header = Buffer.alloc(extended ? 8 : 6);
      header[0] = 0x81;
      header[1] = 0x80 | (extended ? 126 : payload.length);
      if (extended) {
        header.writeUInt16BE(payload.length, 2);
      }
      // The fixed zero mask leaves these synthetic payload bytes unchanged.
      return Buffer.concat([header, payload]);
    }),
  );
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
  getPluginRuntimeGatewayRequestScopeMock.mockReset();
});

describe("local Gateway extension relay wakeup", { concurrent: false }, () => {
  it.each([
    { name: "disabled Browser", enabled: false, driver: "extension" as const },
    { name: "no extension profiles", enabled: true, driver: "openclaw" as const },
  ])("leaves the relay key absent with $name", async ({ enabled, driver }) =>
    withTempDir("openclaw-relay-service-", async (dir) => {
      const stateDir = await fs.realpath(dir);
      const credentials = path.join(stateDir, "credentials");
      const config = {
        gateway: { auth: GATEWAY_AUTH },
        browser: { enabled, profiles: { chrome: { driver, cdpPort: 18799 } } },
      };
      setRuntimeConfigSnapshot(config, config);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials },
        async () => {
          try {
            const state = await startBrowserControlServiceFromConfig();
            expect(state !== null).toBe(enabled);
            await expect(
              fs.stat(path.join(credentials, "browser-extension-relay.secret")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await stopBrowserControlService();
          }
        },
      );
    }),
  );

  it.each([
    [false, false, false, undefined, false],
    [true, false, false, undefined, false],
    [true, true, false, undefined, false],
    [true, true, true, undefined, false],
    [false, false, false, undefined, true],
    [false, false, false, "open", false],
    [true, true, true, "open", false],
    [false, false, false, "head", false],
    [true, true, false, "head", false],
  ] as const)(
    "authenticates Gateway ingress: waiting=%s standalone=%s malformed=%s legacy=%s saturated=%s",
    async (waiting, standalone, malformed, legacy, saturatedSource) =>
      withTempDir("openclaw-gateway-relay-wakeup-", async (dir) => {
        const stateDir = await fs.realpath(dir);
        const credentials = path.join(stateDir, "credentials");
        const secretPath = path.join(credentials, "browser-extension-relay.secret");
        const gatewayPort = await getFreePort();
        let relayPort = await getFreePort();
        while (relayPort === gatewayPort) {
          relayPort = await getFreePort();
        }
        await fs.mkdir(credentials, { recursive: true });
        await fs.writeFile(secretPath, `${RELAY_KEY}\n`, { mode: 0o600 });

        const config = {
          gateway: { port: gatewayPort, auth: GATEWAY_AUTH },
          browser: {
            enabled: true,
            extensionRelay: { allowLegacyAuth: Boolean(legacy) },
            profiles: { chrome: { driver: "extension" as const, cdpPort: relayPort } },
          },
        };
        setRuntimeConfigSnapshot(config, config);

        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_OAUTH_DIR: credentials,
            OPENCLAW_GATEWAY_PORT: String(gatewayPort),
          },
          async () => {
            const coalesced =
              legacy === "head" ? encodeUpgradeHead([EXTENSION_HELLO, INVENTORY]) : undefined;
            const { handleGatewayExtensionUpgrade } = await getGatewayExtensionRelayModule();
            const gatewayServer = http.createServer((_req, res) => {
              res.writeHead(426);
              res.end();
            });
            let upgradeHeadBytes = 0;
            gatewayServer.on("upgrade", (req, socket, head) => {
              // TCP writes cannot guarantee Node's upgrade-head size; supply that exact boundary.
              const initialHead = coalesced ?? head;
              upgradeHeadBytes = initialHead.byteLength;
              const preparedClientIp = req.headers["x-test-client-ip"];
              getPluginRuntimeGatewayRequestScopeMock.mockReturnValue(
                typeof preparedClientIp === "string"
                  ? { client: { clientIp: preparedClientIp } }
                  : undefined,
              );
              void handleGatewayExtensionUpgrade(req, socket, initialHead);
            });
            let extension: WebSocket | undefined;
            let saturationSockets: WebSocket[] = [];
            let daemon: Awaited<ReturnType<typeof runExtensionRelayDaemon>> | undefined;
            const requestController = new AbortController();
            let browserAvailable: Promise<void> | undefined;
            try {
              await new Promise<void>((resolve) => {
                gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
              });
              expect(getBrowserControlState()).toBeNull();
              if (standalone) {
                daemon = await runExtensionRelayDaemon({ port: relayPort });
              }

              const pairing = await buildBrowserExtensionPairing({
                cfg: config,
                localTransport: "gateway",
              });
              expect(pairing).toMatchObject({ relayPort, topology: "local" });
              const parsed = parsePairingString(pairing.pairingString);
              assert(parsed, "local pairing did not parse");

              if (waiting) {
                await startBrowserControlServiceFromConfig();
                browserAvailable = chromeProfile().ensureBrowserAvailable({
                  signal: requestController.signal,
                });
              }

              const protocols = legacy
                ? ["openclaw-extension-relay", `openclaw-extension-token.${RELAY_KEY}`]
                : BROWSER_RELAY_EXTENSION_SUBPROTOCOL;
              if (saturatedSource) {
                saturationSockets = await Promise.all(
                  Array.from({ length: 32 }, async () => {
                    const ws = new WebSocket(parsed.relayUrl, protocols, {
                      headers: { "x-test-client-ip": "198.51.100.10" },
                    });
                    ws.on("error", () => {});
                    await once(ws, "open");
                    return ws;
                  }),
                );
                const overflow = new WebSocket(parsed.relayUrl, protocols, {
                  headers: { "x-test-client-ip": "198.51.100.10" },
                });
                overflow.on("error", () => {});
                const overflowClosed = once(overflow, "close");
                await once(overflow, "open");
                const [overflowCode] = await overflowClosed;
                expect(overflowCode).toBe(4013);
              }
              extension = new WebSocket(parsed.relayUrl, protocols, {
                ...(saturatedSource ? { headers: { "x-test-client-ip": "203.0.113.20" } } : {}),
                origin: "chrome-extension://gateway-wakeup-integration",
              });
              await once(extension, "open");
              if (!legacy) {
                await authenticateExtension(extension, RELAY_KEY, 2_000);
              }
              if (legacy === "head") {
                expect(upgradeHeadBytes).toBe(coalesced?.byteLength);
              } else {
                extension.send(JSON.stringify(EXTENSION_HELLO));
              }

              await expect
                .poll(async () => {
                  const currentRelay = getBrowserControlState()?.extensionRelays?.get("chrome");
                  return currentRelay?.ownership === "borrowed"
                    ? (await currentRelay.client.status()).ready
                    : currentRelay?.bridge.extensionConnected;
                })
                .toBe(true);
              await expect(browserAvailable ?? Promise.resolve()).resolves.toBeUndefined();
              const relay = getBrowserControlState()?.extensionRelays?.get("chrome");
              expect(relay?.port).toBe(pairing.relayPort);
              assert(relay, "extension relay did not start");
              if (coalesced) {
                await expect(relayInventory(relayPort)).resolves.toMatchObject(INVENTORY.tabs);
              }
              if (standalone) {
                assert(relay.ownership === "borrowed", "Expected borrowed relay");
                await expect(relay.client.status()).resolves.toMatchObject({
                  ready: true,
                  identity: { extensionVersion: "2", browserVersion: "Chrome/test" },
                });
                expect(new URL(chromeProfile().profile.cdpUrl).username).toBe("");
                if (malformed) {
                  const closed = once(extension, "close");
                  extension.send("invalid client frame", { mask: false });
                  const [code] = await closed;
                  expect(code).toBe(1002);
                  await expect.poll(async () => (await relay.client.status()).ready).toBe(false);
                }
                await stopBrowserControlService();
                const contender = await runExtensionRelayDaemon({ port: relayPort });
                await expect(contender.done).resolves.toBe("port-in-use");
                return;
              }
              assert(relay.ownership === "owned", "Expected owned relay");

              for (let request = 0; request < 3; request += 1) {
                const cdpUrl = new URL(chromeProfile().profile.cdpUrl);
                expect(cdpUrl.username).toBe("openclaw-internal");
                expect(cdpUrl.password === relay.internalToken).toBe(true);
                expect(getBrowserControlState()?.extensionRelays?.get("chrome")).toBe(relay);
                expect(extension.readyState).toBe(WebSocket.OPEN);
              }

              const authorization = Buffer.from(
                `openclaw-internal:${relay.internalToken}`,
              ).toString("base64");
              const response = await fetch(`http://127.0.0.1:${pairing.relayPort}/json/version`, {
                headers: { Authorization: `Basic ${authorization}` },
              });
              expect(response.status).toBe(200);
              await expect(response.json()).resolves.toMatchObject({
                Browser: "Chrome/test",
                webSocketDebuggerUrl: `ws://127.0.0.1:${pairing.relayPort}/cdp`,
              });
            } finally {
              requestController.abort();
              await browserAvailable?.catch(() => {});
              extension?.terminate();
              saturationSockets.forEach((socket) => socket.terminate());
              await stopBrowserControlService();
              daemon?.stop();
              await daemon?.done;
              await closeServer(gatewayServer);
            }
          },
        );
      }),
  );
});
