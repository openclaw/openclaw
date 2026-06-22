import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MsteamsMediaStream, type MsteamsSession } from "./msteams-media-stream.js";

const SECRET = "test-shared-secret";
const PATH = "/voice/msteams/stream";

function signHmac(secret: string, ts: number, callId: string): string {
  return crypto.createHmac("sha256", secret).update(`${ts}.${callId}`).digest("hex");
}

/** Pick a port unlikely to collide. Range 31000-39999. */
function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 9000);
}

async function startServer(opts: {
  port: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  preStartTimeoutMs?: number;
  onSessionStart?: (s: MsteamsSession) => void;
  onSessionEnd?: (info: { callId: string; reason: string }) => void;
  onAudioFrame?: (info: {
    callId: string;
    seq: number;
    timestampMs: number;
    payload: Buffer;
  }) => void;
  onRecordingStatus?: (info: { callId: string; status: string }) => void;
  onVideoFrame?: (info: {
    callId: string;
    source: "camera" | "screenshare";
    ts: number;
    width: number;
    height: number;
    mime: string;
    dataBase64: string;
  }) => void;
}): Promise<MsteamsMediaStream> {
  const server = new MsteamsMediaStream({
    port: opts.port,
    path: PATH,
    sharedSecret: SECRET,
    maxConnections: opts.maxConnections,
    maxConnectionsPerIp: opts.maxConnectionsPerIp,
    preStartTimeoutMs: opts.preStartTimeoutMs,
    onSessionStart: opts.onSessionStart,
    onSessionEnd: opts.onSessionEnd,
    onAudioFrame: opts.onAudioFrame,
    onRecordingStatus: opts.onRecordingStatus,
    onVideoFrame: opts.onVideoFrame,
  });
  await server.start();
  return server;
}

/** Open an authenticated WS connection for a callId. */
function openAuthed(port: number, callId: string): WebSocket {
  const ts = Date.now();
  return new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
    headers: {
      "x-openclawteamsbridge-timestamp": String(ts),
      "x-openclawteamsbridge-signature": signHmac(SECRET, ts, callId),
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("MsteamsMediaStream", () => {
  let server: MsteamsMediaStream | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("accepts a connection with valid HMAC + parses session.start", async () => {
    const port = randomPort();
    let receivedSession: MsteamsSession | undefined;
    server = await startServer({
      port,
      onSessionStart: (s) => {
        receivedSession = s;
      },
    });

    const callId = "call-abc";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": sig,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-xyz",
        caller: { aadId: "aad-1", displayName: "Alice", tenantId: "tenant-1" },
      }),
    );

    await waitFor(() => receivedSession !== undefined);

    expect(receivedSession?.callId).toBe(callId);
    expect(receivedSession?.threadId).toBe("thread-xyz");
    expect(receivedSession?.caller.displayName).toBe("Alice");
    expect(receivedSession?.caller.aadId).toBe("aad-1");
    expect(server.sessionCount).toBe(1);

    ws.close();
  });

  it("session.send signals delivery: true while open, false once the socket has closed", async () => {
    // streamPcmFrames relies on this to abort playback when a caller hangs up mid-frame, instead of
    // advancing seq/timestamps and reporting audio as delivered on a dead socket.
    const port = randomPort();
    let session: MsteamsSession | undefined;
    server = await startServer({
      port,
      onSessionStart: (s) => {
        session = s;
      },
    });

    const callId = "call-send-status";
    const ws = openAuthed(port, callId);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-1",
        caller: { aadId: "aad-1", displayName: "Alice", tenantId: "tenant-1" },
      }),
    );
    await waitFor(() => session !== undefined);

    // Open socket → the frame is delivered.
    expect(
      session?.send({ type: "audio.frame", seq: 0, timestampMs: 0, payloadBase64: "AA==" }),
    ).toBe(true);

    // Closed socket → the send is dropped and reported as not delivered.
    ws.close();
    await waitFor(() => server?.sessionCount === 0);
    expect(
      session?.send({ type: "audio.frame", seq: 1, timestampMs: 20, payloadBase64: "AA==" }),
    ).toBe(false);
  });

  it("rejects upgrade with a bad HMAC signature", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const callId = "call-bad-sig";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(Date.now()),
        "x-openclawteamsbridge-signature": "deadbeef",
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve("unexpected-response");
      });
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
    expect(server.sessionCount).toBe(0);
  });

  it("rejects upgrade when timestamp is far outside the HMAC window", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const callId = "call-stale-ts";
    const staleTs = Date.now() - 5 * 60_000; // 5 minutes old
    const sig = signHmac(SECRET, staleTs, callId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(staleTs),
        "x-openclawteamsbridge-signature": sig,
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", () => resolve("unexpected-response"));
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
  });

  it("rejects upgrade missing the callId in the path", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const ts = Date.now();
    const sig = signHmac(SECRET, ts, "");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": sig,
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", () => resolve("unexpected-response"));
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
  });

  it("decodes audio.frame and emits via onAudioFrame", async () => {
    const port = randomPort();
    const received: Array<{ callId: string; seq: number; payload: Buffer }> = [];
    server = await startServer({
      port,
      onAudioFrame: (info) => {
        received.push({ callId: info.callId, seq: info.seq, payload: info.payload });
      },
    });

    const callId = "call-audio";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const rawAudio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    ws.send(
      JSON.stringify({
        type: "audio.frame",
        seq: 42,
        timestampMs: Date.now(),
        payloadBase64: rawAudio.toString("base64"),
      }),
    );

    await waitFor(() => received.length > 0);
    expect(received[0]?.callId).toBe(callId);
    expect(received[0]?.seq).toBe(42);
    expect(received[0]?.payload.equals(rawAudio)).toBe(true);

    ws.close();
  });

  it("session.end triggers onSessionEnd and closes the socket", async () => {
    const port = randomPort();
    let endInfo: { callId: string; reason: string } | undefined;
    server = await startServer({
      port,
      onSessionEnd: (info) => {
        endInfo = info;
      },
    });

    const callId = "call-end";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));

    await waitFor(() => endInfo !== undefined);
    expect(endInfo?.callId).toBe(callId);
    expect(endInfo?.reason).toBe("call-ended");
  });

  it("fires onSessionEnd when a started session's socket closes abruptly", async () => {
    const port = randomPort();
    const ends: Array<{ callId: string; reason: string }> = [];
    let started = false;
    server = await startServer({
      port,
      onSessionStart: () => {
        started = true;
      },
      onSessionEnd: (info) => ends.push(info),
    });

    const callId = "call-drop";
    const ws = openAuthed(port, callId);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({ type: "session.start", callId, threadId: "t", caller: { aadId: "a" } }),
    );
    await waitFor(() => started);

    ws.close(); // abrupt close — no session.end frame

    await waitFor(() => ends.length > 0);
    expect(ends).toEqual([{ callId, reason: "socket-closed" }]);
  });

  it("does not double-fire onSessionEnd when the socket closes after session.end", async () => {
    const port = randomPort();
    const ends: Array<{ callId: string; reason: string }> = [];
    server = await startServer({ port, onSessionEnd: (info) => ends.push(info) });

    const callId = "call-end-once";
    const ws = openAuthed(port, callId);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({ type: "session.start", callId, threadId: "t", caller: { aadId: "a" } }),
    );
    ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));

    await waitFor(() => ends.length > 0);
    // The server closes the socket after session.end; let the close event run.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(ends).toEqual([{ callId, reason: "call-ended" }]);
  });

  it("does not fire onSessionEnd when the socket closes before session.start", async () => {
    const port = randomPort();
    const ends: Array<{ callId: string; reason: string }> = [];
    server = await startServer({ port, onSessionEnd: (info) => ends.push(info) });

    const ws = openAuthed(port, "call-prestart");
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.close(); // close before any session.start

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(ends).toHaveLength(0);
  });

  it("drops the connection when an inbound frame exceeds the payload cap", async () => {
    const port = randomPort();
    let frames = 0;
    server = await startServer({
      port,
      onAudioFrame: () => {
        frames += 1;
      },
    });

    const callId = "call-oversize";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // ~3 MB base64 payload — over the 2 MB inbound cap (sized for video.frame). ws closes
    // oversized frames with code 1009 (message too big) before they reach JSON parsing.
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.send(
        JSON.stringify({
          type: "audio.frame",
          seq: 0,
          timestampMs: Date.now(),
          payloadBase64: "A".repeat(3 * 1024 * 1024),
        }),
      );
    });

    expect(closeCode).toBe(1009);
    expect(frames).toBe(0);
  });

  it("parses video.frame and emits via onVideoFrame", async () => {
    const port = randomPort();
    const received: Array<{ source: string; width: number; height: number; dataBase64: string }> =
      [];
    server = await startServer({ port, onVideoFrame: (info) => received.push(info) });

    const callId = "call-video";
    const ws = openAuthed(port, callId);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "video.frame",
        source: "screenshare",
        ts: 1719,
        width: 1280,
        height: 720,
        mime: "image/jpeg",
        dataBase64: "AQID",
      }),
    );

    await waitFor(() => received.length > 0);
    expect(received[0]).toMatchObject({
      source: "screenshare",
      width: 1280,
      height: 720,
      dataBase64: "AQID",
    });
  });

  it("rejects connections beyond maxConnections", async () => {
    const port = randomPort();
    server = await startServer({ port, maxConnections: 1 });

    const ws1 = openAuthed(port, "call-cap-1");
    await new Promise<void>((resolve, reject) => {
      ws1.once("open", () => resolve());
      ws1.once("error", reject);
    });
    expect(server.sessionCount).toBe(1);

    const ws2 = openAuthed(port, "call-cap-2");
    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws2.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(503);
        resolve("unexpected-response");
      });
      ws2.once("error", () => resolve("error"));
      ws2.once("open", () => resolve("open"));
    });
    expect(outcome).not.toBe("open");
    expect(server.sessionCount).toBe(1);
    ws1.close();
  });

  it("rejects connections beyond maxConnectionsPerIp", async () => {
    const port = randomPort();
    server = await startServer({ port, maxConnectionsPerIp: 1 });

    const ws1 = openAuthed(port, "call-ip-1");
    await new Promise<void>((resolve, reject) => {
      ws1.once("open", () => resolve());
      ws1.once("error", reject);
    });

    const ws2 = openAuthed(port, "call-ip-2");
    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws2.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(503);
        resolve("unexpected-response");
      });
      ws2.once("error", () => resolve("error"));
      ws2.once("open", () => resolve("open"));
    });
    expect(outcome).not.toBe("open");
    ws1.close();
  });

  it("rejects session.start whose callId does not match the authenticated path", async () => {
    const port = randomPort();
    let started = false;
    server = await startServer({
      port,
      onSessionStart: () => {
        started = true;
      },
    });

    const ws = openAuthed(port, "call-auth");
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.send(
        JSON.stringify({
          type: "session.start",
          callId: "call-spoofed",
          threadId: "thread-1",
          caller: { aadId: "aad-1" },
        }),
      );
    });

    expect(started).toBe(false);
    expect(closeCode).toBeGreaterThan(0);
    expect(server.sessionCount).toBe(0);
  });

  it("closes a connection that never sends session.start", async () => {
    const port = randomPort();
    server = await startServer({ port, preStartTimeoutMs: 120 });

    const ws = openAuthed(port, "call-idle");
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(server.sessionCount).toBe(1);

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
    expect(server.sessionCount).toBe(0);
  });

  it("surfaces recording status from session.start and recording.status messages", async () => {
    const port = randomPort();
    let startStatus: string | undefined;
    const statuses: string[] = [];
    server = await startServer({
      port,
      onSessionStart: (s) => {
        startStatus = s.recordingStatus;
      },
      onRecordingStatus: (info) => {
        statuses.push(info.status);
      },
    });

    const callId = "call-rec";
    const ws = openAuthed(port, callId);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-rec",
        caller: { aadId: "aad-1" },
        recordingStatus: "inactive",
      }),
    );
    await waitFor(() => startStatus !== undefined);
    expect(startStatus).toBe("inactive");

    ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
    await waitFor(() => statuses.length > 0);
    expect(statuses).toEqual(["active"]);

    ws.close();
  });
});
