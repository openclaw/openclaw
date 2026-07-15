/**
 * Real behavior proof: client sends cancel frames through WebSocket.
 *
 * These tests verify that the GatewayClient sends a `{type:"cancel", id}`
 * frame over the real WebSocket connection when a request times out or is
 * aborted via AbortSignal. A minimal WebSocket server captures the wire
 * frames to prove the cancel frame reaches the server without mocking.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { GatewayClient } from "./client.js";
import { buildMinimalGatewayHelloOkPayload } from "./test-helpers-minimal-gateway.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err: Error | null) => (err ? reject(err) : resolve(port)));
    });
  });
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((e) => Buffer.from(e))).toString("utf8");
  return String(data);
}

interface CapturedFrame {
  type: string;
  id?: string;
  method?: string;
  event?: string;
}

describe("client cancel frame proof", () => {
  let wss: WebSocketServer | null = null;
  let port: number = 0;
  let capturedFrames: CapturedFrame[] = [];
  let wsSockets: WebSocket[] = [];

  beforeEach(async () => {
    capturedFrames = [];
    wsSockets = [];
    port = await getFreePort();
  });

  afterEach(async () => {
    for (const sock of wsSockets) {
      try {
        sock.terminate();
      } catch {
        /* ignore */
      }
    }
    wsSockets = [];
    if (wss) {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
      wss = null;
    }
  });

  // Start a minimal gateway server that handles connect and tracks all frames.
  async function startMinimalGateway(): Promise<void> {
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      wsSockets.push(socket);
      // Send the connect challenge immediately so the client can proceed
      // with the device-auth handshake.
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "proof-nonce" },
        }),
      );
      socket.on("message", (data: RawData) => {
        const text = rawDataToString(data);
        let parsed: CapturedFrame;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        capturedFrames.push(parsed);

        // Handle connect handshake.
        // 1. Server sends connect.challenge event with nonce.
        // 2. Client sends connect request with device auth.
        // 3. Server responds with hello-ok payload matched to the connect request id.
        if (parsed.type === "req" && parsed.method === "connect" && parsed.id) {
          const helloOkPayload = buildMinimalGatewayHelloOkPayload({
            connId: "proof-conn",
            methods: ["proof.echo", "node.invoke"],
          });
          socket.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: helloOkPayload,
            }),
          );
          return;
        }

        // Respond to proof.echo requests (for testing normal request flow).
        if (parsed.type === "req" && parsed.method === "proof.echo" && parsed.id) {
          // Delay the response to simulate slow server processing,
          // giving the client time to time out.
          setTimeout(() => {
            try {
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: parsed.id,
                  ok: true,
                  payload: { echo: "pong" },
                }),
              );
            } catch {
              // Socket may be closed by then.
            }
          }, 5000);
          return;
        }
      });
    });
  }

  // Connect a GatewayClient and wait for hello-ok.
  async function connectClient(opts?: { requestTimeoutMs?: number }): Promise<GatewayClient> {
    return await new Promise<GatewayClient>((resolve, reject) => {
      let settled = false;
      const stop = (err?: Error, client?: GatewayClient) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          void client?.stopAndWait({ timeoutMs: 1000 }).catch(() => {
            client?.stop();
          });
          reject(err);
        } else {
          resolve(client!);
        }
      };
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        requestTimeoutMs: opts?.requestTimeoutMs ?? 30_000,
        connectChallengeTimeoutMs: 3000,
        clientDisplayName: "proof-test",
        onHelloOk: () => stop(undefined, client),
        onConnectError: (err) => stop(err),
        onClose: (code, reason) => stop(new Error(`gateway closed (${code}): ${reason}`)),
      });
      const timer = setTimeout(() => stop(new Error("connect timeout")), 5000);
      client.start();
    });
  }

  // ── Proof tests ──────────────────────────────────────────────────────

  it("PROOF-cancel-frame-timeout: sends cancel frame through WebSocket on request timeout", async () => {
    await startMinimalGateway();
    const client = await connectClient({ requestTimeoutMs: 500 });

    // Verify handshake completed.
    expect(capturedFrames.some((f) => f.method === "connect")).toBe(true);

    // Send a request that the server will delay (proof.echo takes 5s).
    // The client has a 500ms timeout, so it will time out before the response.
    const reqPromise = client.request("proof.echo", { data: "hello" }, { timeoutMs: 500 });
    await expect(reqPromise).rejects.toThrow(/timeout/i);

    // Wait for IO to flush.
    await new Promise((r) => setTimeout(r, 200));

    // Proof: a cancel frame was sent for the timed-out request.
    const cancelFrames = capturedFrames.filter((f) => f.type === "cancel");
    expect(cancelFrames.length).toBeGreaterThanOrEqual(1);
    expect(cancelFrames[0]!.id).toBeTruthy();
    expect(cancelFrames[0]!.id!.length).toBeGreaterThan(0);

    client.stop();
  });

  it("PROOF-cancel-frame-abort: sends cancel frame through WebSocket on AbortSignal abort", async () => {
    await startMinimalGateway();
    const client = await connectClient({ requestTimeoutMs: 10_000 });

    // Verify handshake completed.
    expect(capturedFrames.some((f) => f.method === "connect")).toBe(true);

    // Send a request with an AbortSignal that we will abort.
    const abortController = new AbortController();
    const reqPromise = client.request(
      "proof.echo",
      { data: "hello" },
      { signal: abortController.signal, timeoutMs: null },
    );

    // Let the request frame be sent.
    await new Promise((r) => setTimeout(r, 50));

    // Abort the signal (simulating user cancellation or socket disconnect).
    abortController.abort();

    await expect(reqPromise).rejects.toThrow(/aborted/i);

    // Wait for IO to flush.
    await new Promise((r) => setTimeout(r, 200));

    // Proof: a cancel frame was sent for the aborted request.
    const cancelFrames = capturedFrames.filter((f) => f.type === "cancel");
    expect(cancelFrames.length).toBeGreaterThanOrEqual(1);
    expect(cancelFrames[0]!.id).toBeTruthy();

    client.stop();
  });

  it("PROOF-cancel-frame-id: the cancel frame id matches the request id", async () => {
    await startMinimalGateway();
    const client = await connectClient({ requestTimeoutMs: 500 });

    // Track the request ID from the captured req frame.
    const reqCountBefore = capturedFrames.filter((f) => f.type === "req").length;

    const reqPromise = client.request("proof.echo", { data: "match-me" }, { timeoutMs: 500 });
    await expect(reqPromise).rejects.toThrow(/timeout/i);

    await new Promise((r) => setTimeout(r, 200));

    // Get the request frame that was sent.
    const reqFrames = capturedFrames.filter((f) => f.type === "req" && f.method === "proof.echo");
    expect(reqFrames.length).toBeGreaterThanOrEqual(reqCountBefore);

    const lastReq = reqFrames[reqFrames.length - 1]!;
    const reqId = lastReq.id!;

    // Get the cancel frame.
    const cancelFrames = capturedFrames.filter((f) => f.type === "cancel");
    const matchingCancel = cancelFrames.find((f) => f.id === reqId);

    // Proof: the cancel frame id exactly matches the request id.
    expect(matchingCancel).toBeDefined();
    expect(matchingCancel!.id).toBe(reqId);

    client.stop();
  });

  it("PROOF-no-cancel-for-success: does NOT send cancel frame for successful requests", async () => {
    await startMinimalGateway();
    const client = await connectClient({ requestTimeoutMs: 30_000 });

    // Track frame counts before and after.
    const cancelCountBefore = capturedFrames.filter((f) => f.type === "cancel").length;
    const reqCountBefore = capturedFrames.filter((f) => f.type === "req").length;

    // Use a sufficiently long timeout so the request completes normally.
    const result = await client.request("proof.echo", { data: "hello" }, { timeoutMs: 10_000 });
    expect(result).toBeDefined();

    await new Promise((r) => setTimeout(r, 200));

    // Proof: no new cancel frames were sent.
    const cancelFramesAfter = capturedFrames.filter((f) => f.type === "cancel");
    expect(cancelFramesAfter.length).toBe(cancelCountBefore);

    // Proof: only the expected request frames were sent (no phantom frames).
    const reqFramesAfter = capturedFrames.filter((f) => f.type === "req");
    expect(reqFramesAfter.length).toBe(reqCountBefore + 1);

    client.stop();
  });
});
