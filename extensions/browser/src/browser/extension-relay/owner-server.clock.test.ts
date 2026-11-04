import { once } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, it, vi } from "vitest";
import { relayOwnerReply } from "./owner-protocol.js";
import { attachRelayOwner } from "./owner-server.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { EXTENSION_RELAY_MAX_PAYLOAD_BYTES } from "./relay-server.js";

// The relay capture expires on the process-local elapsed clock: a host wall-clock
// correction must not retire an operation whose 5-minute TTL window is still open.
it("keeps a captured relay operation current across a wall-clock step", async () => {
  const bridge = new ExtensionRelayBridge();
  vi.spyOn(bridge, "captureOperationTarget").mockReturnValue(
    Object.assign(() => "target-id", { isCurrent: () => true }),
  );
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback listener");
  }
  const accepted = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
  let retire: (() => Promise<void>) | undefined;
  try {
    await once(peer, "open");
    const socket = await accepted;
    retire = attachRelayOwner({
      ws: socket,
      bridge,
      allowLegacyAuth: false,
      isCurrent: () => true,
    });

    const captureRef = (): Promise<string> => {
      const opened = once(peer, "message");
      peer.send(JSON.stringify({ id: 1, op: "capture", targetId: "tab-1" }));
      return opened.then(([raw]) => {
        const reply = relayOwnerReply.parse(JSON.parse(rawDataToString(raw)));
        if (typeof reply.result !== "string") {
          throw new Error(`capture did not return a ref: ${JSON.stringify(reply)}`);
        }
        return reply.result;
      });
    };
    const resolveFor = (ref: string): Promise<string | null> => {
      const opened = once(peer, "message");
      peer.send(JSON.stringify({ id: 2, op: "resolve", ref }));
      return opened.then(([raw]) => {
        const reply = relayOwnerReply.parse(JSON.parse(rawDataToString(raw)));
        return reply.error ? null : ((reply.result as string | undefined) ?? null);
      });
    };

    const ref = await captureRef();
    // Step the host wall clock past the 5-minute TTL without running the timer.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await resolveFor(ref)).toBe("target-id");
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    bridge.dispose();
    peer.terminate();
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await retire?.().catch(() => {});
  }
});
