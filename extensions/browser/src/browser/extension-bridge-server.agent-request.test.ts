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

function openSocket(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/extension`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Resolve with the first message whose JSON matches the predicate. */
function waitFor(ws: WebSocket, match: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);
    const onMsg = (data: WebSocket.RawData) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (match(m)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(m);
      }
    };
    ws.on("message", onMsg);
  });
}

async function handshake(ws: WebSocket): Promise<void> {
  await waitFor(ws, (m) => m.event === "connect.challenge");
  ws.send(JSON.stringify({ type: "req", id: 1, method: "connect" }));
  await waitFor(ws, (m) => m.type === "res" && m.id === 1 && m.ok === true);
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
    const ws = await openSocket();
    await handshake(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: 2,
        method: "agent.request",
        params: { message: "hi from the side panel", sessionKey: "agent:main:main" },
      }),
    );
    const res = await waitFor(ws, (m) => m.type === "res" && m.id === 2);

    expect(onAgentRequest).toHaveBeenCalledWith({
      message: "hi from the side panel",
      sessionKey: "agent:main:main",
    });
    expect(res.result?.ok).toBe(true);
    ws.close();
  });

  it("acks an error when no node routing is wired (gateway-only deployment)", async () => {
    handle = await startExtensionBridgeServer({ port: PORT }); // no onAgentRequest
    const ws = await openSocket();
    await handshake(ws);

    ws.send(
      JSON.stringify({ type: "req", id: 2, method: "agent.request", params: { message: "x" } }),
    );
    const res = await waitFor(ws, (m) => m.type === "res" && m.id === 2);

    expect(String(res.error)).toMatch(/node agent routing unavailable/);
    ws.close();
  });

  it("rejects an empty message", async () => {
    const onAgentRequest = vi.fn().mockResolvedValue(undefined);
    handle = await startExtensionBridgeServer({ port: PORT, onAgentRequest });
    const ws = await openSocket();
    await handshake(ws);

    ws.send(
      JSON.stringify({ type: "req", id: 2, method: "agent.request", params: { message: "   " } }),
    );
    const res = await waitFor(ws, (m) => m.type === "res" && m.id === 2);

    expect(onAgentRequest).not.toHaveBeenCalled();
    expect(String(res.error)).toMatch(/message required/);
    ws.close();
  });

  it("surfaces an onAgentRequest failure as an error ack", async () => {
    const onAgentRequest = vi.fn().mockRejectedValue(new Error("node not connected"));
    handle = await startExtensionBridgeServer({ port: PORT, onAgentRequest });
    const ws = await openSocket();
    await handshake(ws);

    ws.send(
      JSON.stringify({
        type: "req",
        id: 2,
        method: "agent.request",
        params: { message: "hi", sessionKey: "agent:main:main" },
      }),
    );
    const res = await waitFor(ws, (m) => m.type === "res" && m.id === 2);

    expect(String(res.error)).toMatch(/node not connected/);
    ws.close();
  });
});
