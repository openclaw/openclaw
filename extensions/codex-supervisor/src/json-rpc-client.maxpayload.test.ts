// Codex Supervisor tests cover the WebSocketCodexJsonRpcConnection maxPayload
// guard — a hostile or misbehaving Codex app-server could otherwise stream an
// unbounded JSON-RPC frame into memory (OOM vector for the supervisor worker).
//
// Real WebSocketServer + real WebSocket client (loopback `ws://localhost`) —
// not mocked. Verifies that the `ws` library's `maxPayload` enforcement is
// wired through the production constructor (`new WebSocket(...)` inside
// `connectCodexAppServerEndpoint`), not just the SDK helper. Helper-only
// unit tests on the underlying `ws` library would not catch a regression
// where the production constructor dropped the option or pointed it at the
// wrong WebSocket instance.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { connectCodexAppServerEndpoint } from "./json-rpc-client.js";
import type { CodexSupervisorEndpoint } from "./types.js";

// Same constant the source declares. Asserted in the test so a silent change
// to the cap value triggers a review reminder here, not a silent drift.
const MAX_CODEX_SUPERVISOR_WS_INBOUND_BYTES = 16 * 1024 * 1024;

describe("connectCodexAppServerEndpoint websocket maxPayload guard", () => {
  let server: WebSocketServer;
  let serverPort: number;
  let connection: { close: () => Promise<void> } | null = null;

  beforeEach(async () => {
    // Server-side has a generous cap so it can SEND the hostile 32 MiB frame
    // for the test; only the CLIENT is the surface we are bounding.
    server = new WebSocketServer({ port: 0, maxPayload: 64 * 1024 * 1024 });
    await once(server, "listening");
    serverPort = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (connection) {
      await connection.close().catch(() => undefined);
      connection = null;
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects an inbound frame that exceeds the 16 MiB cap", async () => {
    const endpoint: CodexSupervisorEndpoint = {
      id: "loopback-test-endpoint",
      transport: "websocket",
      url: `ws://localhost:${serverPort}`,
    };

    // Kick off connect + initialize; this hangs waiting for the server to
    // respond to the initialize request. `.catch` returns the rejected
    // value as-is (typed unknown) so the surrounding test can probe it.
    const connectPromise = connectCodexAppServerEndpoint(endpoint)
      .then((c) => {
        connection = c;
        return null as Error | null;
      })
      .catch((e: unknown) => e as Error);

    // Wait for the server to accept the client connection.
    const [serverSide] = (await once(server, "connection")) as [WebSocket];

    // Hostile frame: 2× the cap (32 MiB). Server sends WITHOUT responding to
    // initialize, so the client's pending initialize request will reject.
    const oversized = Buffer.alloc(2 * MAX_CODEX_SUPERVISOR_WS_INBOUND_BYTES, 0x78);
    serverSide.send(oversized);

    const captured = await connectPromise;
    expect(captured).toBeInstanceOf(Error);
    // The `ws` library emits `RangeError: Max payload size exceeded` (or
    // similar wording depending on version) when an inbound frame exceeds
    // the configured `maxPayload`. Match the contract loosely so the test
    // does not break on minor `ws` wording changes.
    expect((captured as Error).message.toLowerCase()).toMatch(
      /max.*payload|payload.*size|too large|exceeds/i,
    );
  });

  it("accepts a frame well under the 16 MiB cap (regression: the guard does not block normal traffic)", async () => {
    const endpoint: CodexSupervisorEndpoint = {
      id: "loopback-test-endpoint",
      transport: "websocket",
      url: `ws://localhost:${serverPort}`,
    };

    const connectPromise = connectCodexAppServerEndpoint(endpoint)
      .then((c) => {
        connection = c;
        return null as Error | null;
      })
      .catch((e: unknown) => e as Error);

    const [serverSide] = (await once(server, "connection")) as [WebSocket];

    // Wait for the client to send the initialize request and read its id
    // so the response matches — the production client uses `randomUUID()`,
    // so a hard-coded `id: 1` here would be silently dropped by the
    // pending-request lookup in `handleMessage`.
    const [requestRaw] = (await once(serverSide, "message")) as [Buffer];
    const request = JSON.parse(requestRaw.toString()) as { id: string | number };

    // Reply to the initialize request with a small, valid JSON-RPC success
    // frame. The frame is ~120 bytes — well under the 16 MiB cap.
    const initializeResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "loopback-test", version: "0.0.0" },
      },
    });
    serverSide.send(initializeResponse);

    const captured = await connectPromise;
    expect(captured).toBeNull();
    expect(connection).not.toBeNull();
  });
});
