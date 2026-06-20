// Covers the relay-auth gate (#93680 review F1): when a gateway token is
// configured the bridge requires the extension to present a matching HMAC on the
// /extension?token= query (mirrors the extension's deriveRelayToken). With no
// token configured the loopback bridge stays trusted-local.
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import WebSocket from "ws";
import {
  startExtensionBridgeServer,
  type ExtensionBridgeHandle,
} from "./extension-bridge-server.js";

const PORT = 39521;
const AUTH_TOKEN = "super-secret-gateway-token";

// Node HMAC matches the extension's WebCrypto deriveRelayToken byte-for-byte
// (same key + message + hex), and the server's verifyRelayToken recomputes it.
function relayToken(token: string, port: number): string {
  return createHmac("sha256", token)
    .update("openclaw-extension-relay-v1:" + port)
    .digest("hex");
}

interface Client {
  ws: WebSocket;
  waitChallenge: (timeoutMs?: number) => Promise<any>;
  waitClose: (timeoutMs?: number) => Promise<number>;
}

function connect(query: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/extension${query}`);
  const buffer: any[] = [];
  let closeCode: number | null = null;
  const closeWaiters: Array<(c: number) => void> = [];
  const msgWaiters: Array<(m: any) => void> = [];
  ws.on("message", (data: WebSocket.RawData) => {
    let m: any;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    buffer.push(m);
    for (const w of msgWaiters.splice(0)) w(m);
  });
  ws.on("close", (code) => {
    closeCode = code;
    for (const w of closeWaiters.splice(0)) w(code);
  });
  const waitChallenge = (timeoutMs = 3000) =>
    new Promise<any>((resolve, reject) => {
      const found = buffer.find((m) => m.event === "connect.challenge");
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error("timeout: connect.challenge")), timeoutMs);
      msgWaiters.push((m) => {
        if (m.event === "connect.challenge") {
          clearTimeout(t);
          resolve(m);
        }
      });
    });
  const waitClose = (timeoutMs = 3000) =>
    new Promise<number>((resolve, reject) => {
      if (closeCode != null) return resolve(closeCode);
      const t = setTimeout(() => reject(new Error("timeout: close")), timeoutMs);
      closeWaiters.push((c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, waitChallenge, waitClose }));
    ws.once("error", reject);
  });
}

describe("extension bridge relay auth (#93680 F1)", () => {
  let handle: ExtensionBridgeHandle | null = null;
  afterEach(async () => {
    await handle?.stop();
    handle = null;
  });

  it("accepts an extension whose ?token matches the configured gateway-token HMAC", async () => {
    handle = await startExtensionBridgeServer({ port: PORT, authToken: AUTH_TOKEN });
    const c = await connect(`?token=${relayToken(AUTH_TOKEN, PORT)}`);
    expect((await c.waitChallenge()).event).toBe("connect.challenge");
    c.ws.close();
  });

  it("rejects (close 1008) a wrong ?token when a gateway token is configured", async () => {
    handle = await startExtensionBridgeServer({ port: PORT, authToken: AUTH_TOKEN });
    const c = await connect(`?token=deadbeef`);
    expect(await c.waitClose()).toBe(1008);
  });

  it("rejects (close 1008) a missing ?token when a gateway token is configured", async () => {
    handle = await startExtensionBridgeServer({ port: PORT, authToken: AUTH_TOKEN });
    const c = await connect("");
    expect(await c.waitClose()).toBe(1008);
  });

  it("stays trusted-local (challenge, no token) when no gateway token is configured", async () => {
    handle = await startExtensionBridgeServer({ port: PORT });
    const c = await connect("");
    expect((await c.waitChallenge()).event).toBe("connect.challenge");
    c.ws.close();
  });
});
