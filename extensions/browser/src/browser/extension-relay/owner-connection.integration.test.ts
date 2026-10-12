import { once } from "node:events";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { RawData, WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it } from "vitest";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { authenticateRelayOwner } from "./owner-auth-client.js";
import { withConnectedDaemon } from "./relay-coexistence.test-support.js";
import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

afterEach(clearRuntimeConfigSnapshot);

function ownerRequests(ws: WebSocket) {
  let sequence = 0;
  return async (op: string, fields: object = {}) => {
    const id = ++sequence;
    const response = new Promise<{ result?: unknown; error?: string }>((resolve) => {
      const onMessage = (raw: RawData) => {
        const value = JSON.parse(rawDataToString(raw));
        if (value.id === id) {
          ws.off("message", onMessage);
          resolve(value);
        }
      };
      ws.on("message", onMessage);
    });
    ws.send(JSON.stringify({ id, op, ...fields }));
    return await response;
  };
}

it("scopes references to their authenticated connection and releases native claims on peer loss", async () => {
  await withConnectedDaemon(async ({ port, token, extension, holdDetach }) => {
    const connect = () =>
      authenticateRelayOwner({
        port,
        token,
        profile: "chrome",
        signal: new AbortController().signal,
      });
    const first = await connect();
    const second = await connect();
    const request = ownerRequests(first.ws);
    const other = ownerRequests(second.ws);
    const hold = holdDetach();
    try {
      await startBrowserControlServiceFromConfig();
      await createBrowserControlContext().forProfile("chrome").listTabs();
      const { result: ref } = await request("capture", { targetId: "fixture-target" });
      expect(ref).toBeTypeOf("string");
      await expect(other("resolve", { ref })).resolves.toEqual({ id: 1, result: null });
      await request("release", { ref });
      await expect(request("cdp.open", { ref })).resolves.toHaveProperty("error");

      // Give the first owner a real logical claimant before the Gateway drops its own.
      const { result: stream } = await request("cdp.open");
      const attached = new Promise<void>((resolve) => {
        first.ws.on("message", (raw) => {
          const value = JSON.parse(rawDataToString(raw));
          if (
            value.stream === stream &&
            value.frame &&
            JSON.parse(value.frame).method === "Target.attachedToTarget"
          ) {
            resolve();
          }
        });
      });
      first.ws.send(
        JSON.stringify({
          stream,
          frame: JSON.stringify({
            id: 1,
            method: "Target.setAutoAttach",
            params: { autoAttach: true, flatten: true },
          }),
        }),
      );
      await attached;
      await stopBrowserControlService();
      first.ws.terminate();
      await hold.entered;
      expect(extension.readyState).toBe(1);
      await expect(other("ready", { timeoutMs: 0 })).resolves.toMatchObject({
        result: { ready: true, identity: { extensionVersion: "2" } },
      });
      hold.release();
      const closed = once(second.ws, "close");
      await other("close");
      second.ws.close();
      await closed;
    } finally {
      hold.release();
      first.ws.terminate();
      second.ws.terminate();
    }
  });
});

it("owns malformed-frame errors after owner authentication without stopping the relay", async () => {
  await withConnectedDaemon(async ({ port, token, extension }) => {
    const connect = () =>
      authenticateRelayOwner({
        port,
        token,
        profile: "chrome",
        signal: new AbortController().signal,
      });
    const failed = await connect();
    const healthy = await connect();
    try {
      const closed = once(failed.ws, "close");
      failed.ws.send("invalid client frame", { mask: false });
      const [code] = await closed;
      expect(code).toBe(1002);
      await expect(ownerRequests(healthy.ws)("ready", { timeoutMs: 0 })).resolves.toMatchObject({
        result: { ready: true },
      });
      expect(extension.readyState).toBe(1);
    } finally {
      failed.ws.terminate();
      healthy.ws.terminate();
    }
  });
});

it("reacquires a borrowed owner after its socket is lost and still enumerates tabs", async () => {
  await withConnectedDaemon(async () => {
    await startBrowserControlServiceFromConfig();
    const state = getBrowserControlState();
    const profile = createBrowserControlContext().forProfile("chrome");
    const original = state?.extensionRelays?.get("chrome");
    if (!state || original?.ownership !== "borrowed") {
      throw new Error("Expected the daemon's relay to be borrowed");
    }

    const ownerSocket = (original.client as unknown as { ws: WebSocket }).ws;
    const closed = once(ownerSocket, "close");
    ownerSocket.terminate();
    await closed;
    await expect(original.client.close()).resolves.toBeUndefined();

    const recovered = await ensureExtensionRelayForProfile(state, profile.profile);
    if (recovered.ownership !== "borrowed") {
      throw new Error("Expected the recovered relay to be borrowed");
    }
    expect(recovered).not.toBe(original);
    await expect(profile.listTabs()).resolves.toMatchObject([
      expect.objectContaining({ url: "https://example.com/fixture" }),
    ]);
  });
});
