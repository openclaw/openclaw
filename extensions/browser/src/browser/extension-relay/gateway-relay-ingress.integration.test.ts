import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { getGatewayExtensionRelayModule } from "../extension-relay.runtime.js";
import { RELAY_OWNER_LIMIT } from "./owner-protocol.js";
import { sendHello } from "./relay-bridge.test-support.js";
import { withConnectedDaemon } from "./relay-coexistence.test-support.js";
import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["peer-close", "preparation-failure", "superseded"] as const)(
  "releases a paused legacy ingress after %s without retiring the standalone relay",
  (outcome) =>
    withConnectedDaemon(async ({ token, extension }) => {
      const state = await startBrowserControlServiceFromConfig();
      assert(state, "Expected Browser control state");
      const profile = createBrowserControlContext().forProfile("chrome").profile;
      const relay = await ensureExtensionRelayForProfile(state, profile);
      assert(relay.ownership === "borrowed", "Expected borrowed relay");
      const { client } = relay;
      const release = createDeferred<void>();
      const prepared = createDeferred<WebSocket>();
      const prepareIngress = client.prepareIngress.bind(client);
      vi.spyOn(client, "prepareIngress").mockImplementation(async (ws) => {
        // Pause only the handoff, after real owner authentication and stream allocation.
        const attach = await prepareIngress(ws);
        prepared.resolve(ws);
        await release.promise;
        if (outcome === "preparation-failure") {
          throw new Error("ingress preparation interrupted");
        }
        return attach;
      });
      const { handleGatewayExtensionUpgrade } = await getGatewayExtensionRelayModule();
      const server = http.createServer();
      server.on("upgrade", (req, socket, head) => {
        void handleGatewayExtensionUpgrade(req, socket, head);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string", "Expected loopback listener");
      const peer = net.createConnection({ host: "127.0.0.1", port: address.port });
      const candidate = new WebSocket(
        `ws://127.0.0.1:${address.port}/browser/extension?profile=chrome`,
        ["openclaw-extension-relay", `openclaw-extension-token.${token}`],
        {
          origin: "chrome-extension://legacy-ingress-cleanup",
          createConnection: () => peer,
        },
      );
      try {
        await once(candidate, "open");
        sendHello({ onMessage: (frame) => candidate.send(frame) }, []);
        const ws = await prepared.promise;
        expect(ws.isPaused).toBe(true);
        // A hello waiting in the transport must not replace the active extension.
        await expect(client.status()).resolves.toMatchObject({
          identity: { browserVersion: "Chrome/test" },
        });
        const serverClosed = once(ws, "close");
        const peerClosed = once(candidate, "close");
        if (outcome === "peer-close") {
          peer.resetAndDestroy();
        } else if (outcome === "superseded") {
          await stopBrowserControlService();
        }
        if (outcome !== "preparation-failure") {
          await serverClosed;
        }
        release.resolve();
        await serverClosed;
        const [code] = await peerClosed;
        if (outcome === "preparation-failure") {
          expect(code).toBe(1011);
        }
        if (outcome !== "superseded") {
          await expect(client.status()).resolves.toMatchObject({
            ready: true,
            identity: { browserVersion: "Chrome/test" },
          });
          // Exhaust the owner budget to prove the abandoned ingress released its stream.
          for (let index = 0; index < RELAY_OWNER_LIMIT; index += 1) {
            await client.openTransport();
          }
        }
        expect(extension.readyState).toBe(WebSocket.OPEN);
        await stopBrowserControlService();
        expect(extension.readyState).toBe(WebSocket.OPEN);
      } finally {
        release.resolve();
        candidate.terminate();
        await stopBrowserControlService();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }),
);
