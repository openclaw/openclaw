import { once } from "node:events";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler } from "./media-stream.js";
import type {
  OpenAIRealtimeSTTProvider,
  RealtimeSTTSession,
} from "./providers/stt-openai-realtime.js";

const createStubSession = (): RealtimeSTTSession => ({
  connect: async () => {},
  sendAudio: () => {},
  waitForTranscript: async () => "",
  onPartial: () => {},
  onTranscript: () => {},
  onSpeechStart: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (): OpenAIRealtimeSTTProvider =>
  ({
    createSession: () => createStubSession(),
  }) as unknown as OpenAIRealtimeSTTProvider;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    handler.handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/voice/stream`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

const connectWs = async (url: string): Promise<WebSocket> => {
  const ws = new WebSocket(url);
  await withTimeout(once(ws, "open") as Promise<[unknown]>);
  return ws;
};

const waitForClose = async (
  ws: WebSocket,
): Promise<{
  code: number;
  reason: string;
}> => {
  const [code, reason] = (await withTimeout(once(ws, "close") as Promise<[number, Buffer]>)) ?? [];
  return {
    code,
    reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason || ""),
  };
};

describe("MediaStreamHandler TTS queue", () => {
  it("serializes TTS playback and resolves in order", async () => {
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
    });
    const started: number[] = [];
    const finished: number[] = [];

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const first = handler.queueTts("stream-1", async () => {
      started.push(1);
      await firstGate;
      finished.push(1);
    });
    const second = handler.queueTts("stream-1", async () => {
      started.push(2);
      finished.push(2);
    });

    await flush();
    expect(started).toEqual([1]);

    resolveFirst();
    await first;
    await second;

    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1, 2]);
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
    });

    let queuedRan = false;
    const started: string[] = [];

    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    void handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    await flush();
    expect(started).toEqual(["active"]);

    handler.clearTtsQueue("stream-1");
    await active;
    await flush();

    expect(queuedRan).toBe(false);
  });
});

describe("MediaStreamHandler security hardening", () => {
  it("closes idle pre-start connections after timeout", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
      preStartTimeoutMs: 40,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("Start timeout");
      expect(shouldAcceptStreamCalls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("enforces pending connection limits", async () => {
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 1,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const second = await connectWs(server.url);
      const secondClosed = await waitForClose(second);

      expect(secondClosed.code).toBe(1013);
      expect(secondClosed.reason).toContain("Too many pending");
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("rejects upgrades when max connection cap is reached", async () => {
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const secondError = await withTimeout(
        new Promise<Error>((resolve) => {
          const ws = new WebSocket(server.url);
          ws.once("error", (err) => resolve(err as Error));
        }),
      );

      expect(secondError.message).toContain("Unexpected server response: 503");

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("clears pending state after valid start", async () => {
    const handler = new MediaStreamHandler({
      sttProvider: createStubSttProvider(),
      preStartTimeoutMs: 40,
      shouldAcceptStream: () => true,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ123",
          start: { callSid: "CA123", customParameters: { token: "token-123" } },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });
});
