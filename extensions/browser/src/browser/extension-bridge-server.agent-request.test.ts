// Covers the side-panel turn-routing hop: the extension sends an `agent.request`
// over the relay socket and the bridge forwards it to the node-host emitter
// (onAgentRequest), acking acceptance. The reply itself streams back over the
// side panel's own gateway subscription, so the bridge only acks here.
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  startExtensionBridgeServer,
  type ExtensionBridgeHandle,
} from "./extension-bridge-server.js";

const PORT = 39517;

interface Client {
  ws: WebSocket;
  waitFor: (match: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
}

// Buffer messages from socket creation so the bridge's immediate connect.challenge
// (sent on connect, before the client's "open" fires) is never raced/dropped.
function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/extension`);
  const buffer: any[] = [];
  const waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on("message", (data: WebSocket.RawData) => {
    let m: any;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    buffer.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(m)) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  const waitFor = (match: (m: any) => boolean, timeoutMs = 3000): Promise<any> => {
    const existing = buffer.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, waitFor }));
    ws.once("error", reject);
  });
}

async function handshake(c: Client): Promise<void> {
  await c.waitFor((m) => m.event === "connect.challenge");
  c.ws.send(JSON.stringify({ type: "req", id: 1, method: "connect" }));
  await c.waitFor((m) => m.type === "res" && m.id === 1 && m.ok === true);
}

describe("extension bridge agent.request routing", () => {
  let handle: ExtensionBridgeHandle | null = null;

  afterEach(async () => {
    await handle?.stop();
    handle = null;
  });

  it("forwards a side-panel agent.request to onAgentRequest and acks ok", async () => {
    const onAgentRequest = vi.fn().mockResolvedValue(undefined);
    handle = await startExtensionBridgeServer({ port: PORT, onAgentRequest });
    const c = await connect();
    await handshake(c);

    c.ws.send(
      JSON.stringify({
        type: "req",
        id: 2,
        method: "agent.request",
        params: { message: "hi from the side panel", sessionKey: "agent:main:main" },
      }),
    );
    const res = await c.waitFor((m) => m.type === "res" && m.id === 2);

    expect(onAgentRequest).toHaveBeenCalledWith({
      message: "hi from the side panel",
      sessionKey: "agent:main:main",
    });
    expect(res.result?.ok).toBe(true);
    c.ws.close();
  });

  it("acks an error when no node routing is wired (gateway-only deployment)", async () => {
    handle = await startExtensionBridgeServer({ port: PORT }); // no onAgentRequest
    const c = await connect();
    await handshake(c);

    c.ws.send(
      JSON.stringify({ type: "req", id: 2, method: "agent.request", params: { message: "x" } }),
    );
    const res = await c.waitFor((m) => m.type === "res" && m.id === 2);

    expect(String(res.error)).toMatch(/node agent routing unavailable/);
    c.ws.close();
  });

  it("rejects an empty message", async () => {
    const onAgentRequest = vi.fn().mockResolvedValue(undefined);
    handle = await startExtensionBridgeServer({ port: PORT, onAgentRequest });
    const c = await connect();
    await handshake(c);

    c.ws.send(
      JSON.stringify({ type: "req", id: 2, method: "agent.request", params: { message: "   " } }),
    );
    const res = await c.waitFor((m) => m.type === "res" && m.id === 2);

    expect(onAgentRequest).not.toHaveBeenCalled();
    expect(String(res.error)).toMatch(/message required/);
    c.ws.close();
  });

  it("surfaces an onAgentRequest failure as an error ack", async () => {
    const onAgentRequest = vi.fn().mockRejectedValue(new Error("node not connected"));
    handle = await startExtensionBridgeServer({ port: PORT, onAgentRequest });
    const c = await connect();
    await handshake(c);

    c.ws.send(
      JSON.stringify({
        type: "req",
        id: 2,
        method: "agent.request",
        params: { message: "hi", sessionKey: "agent:main:main" },
      }),
    );
    const res = await c.waitFor((m) => m.type === "res" && m.id === 2);

    expect(String(res.error)).toMatch(/node not connected/);
    c.ws.close();
  });
});
