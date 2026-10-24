import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildDeepgramRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

let cleanup: (() => Promise<void>) | undefined;

async function createDeepgramRealtimeServer(params: {
  onRequest?: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
  onConnection?: (ws: WebSocket) => void;
}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws, request) => {
    params.onRequest?.(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    params.onConnection?.(ws);
  });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  cleanup = () =>
    new Promise<void>((resolve) => {
      wss.clients.forEach((ws) => ws.terminate());
      wss.close(() => resolve());
    });
  return { baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}/deepgram/v1` };
}

function sendResult(
  ws: WebSocket,
  params: {
    text: string;
    isFinal?: boolean;
    speechFinal?: boolean;
    fromFinalize?: boolean;
  },
) {
  ws.send(
    JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: params.text }] },
      is_final: params.isFinal ?? false,
      speech_final: params.speechFinal ?? false,
      from_finalize: params.fromFinalize ?? false,
    }),
  );
}

function parseClientMessage(data: RawData): Record<string, unknown> {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function createScenario(onConnection: (ws: WebSocket) => void, endpointingMs = 1000) {
  const { baseUrl } = await createDeepgramRealtimeServer({ onConnection });
  const callbacks = {
    onPartial: vi.fn(),
    onTranscript: vi.fn(),
    onSpeechStart: vi.fn(),
    onError: vi.fn<(error: Error) => void>(),
  };
  const session = provider.createSession({
    providerConfig: { apiKey: "dummy", baseUrl, endpointingMs },
    ...callbacks,
  });
  try {
    await session.connect();
  } catch (error) {
    session.close();
    throw error;
  }
  return {
    ...callbacks,
    session,
    [Symbol.dispose]: () => session.close(),
    waitForDelivery: () =>
      vi.waitFor(() => {
        expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "frames delivered" }),
        );
      }),
  };
}

function sendDeliveryMarker(ws: WebSocket) {
  // Observe delivery without creating another speech turn.
  ws.send(JSON.stringify({ type: "Error", message: "frames delivered" }));
}

async function createFinalizationScenario(reply: boolean) {
  const onFinalize = vi.fn();
  const scenario = await createScenario((ws) => {
    sendResult(ws, { text: "good", isFinal: true });
    sendResult(ws, { text: "bye" });
    ws.on("message", (data) => {
      if (parseClientMessage(data).type !== "Finalize") {
        return;
      }
      onFinalize();
      if (reply) {
        sendResult(ws, { text: "bye", isFinal: true, fromFinalize: true });
      }
    });
  }, 10_000);
  return { ...scenario, onFinalize };
}

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "dg-key",
      baseUrl: undefined,
      model: "nova-3",
      language: "en-US",
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 500,
    });
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });

  it("validates the environment override", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "not a url");
    expect(() => provider.createSession({ providerConfig: { apiKey: "dg-key" } })).toThrow(
      "Invalid Deepgram baseUrl: value is not a valid URL",
    );
  });

  it("does not echo the configured URL in validation errors", () => {
    const rawMarker = "configured-value-marker";
    const nonHttp = `ftp://files.example.com/${rawMarker}`;
    try {
      provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl: nonHttp } });
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^Invalid Deepgram baseUrl: unsupported scheme/);
      expect(message).not.toContain(rawMarker);
    }
  });

  it("connects through an explicit HTTP base URL over loopback WebSocket", async () => {
    const requests: Array<{
      url: URL;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = await createDeepgramRealtimeServer({
      onRequest: (url, headers) => requests.push({ url, headers }),
    });
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl },
    });
    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/deepgram/v1/listen");
    expect(requests[0]?.url.searchParams.get("model")).toBe("nova-3");
    expect(requests[0]?.url.searchParams.get("endpointing")).toBe("800");
    expect(requests[0]?.url.searchParams.has("utterance_end_ms")).toBe(false);
    expect(requests[0]?.headers.authorization).toBe("Token dummy");
  });

  it("does not promote a rejected provisional tail on an empty speech-final result", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, { text: "delete everything" });
      sendResult(ws, { text: "", isFinal: true, speechFinal: true });
      ws.send(JSON.stringify({ type: "SpeechStarted" }));
      sendDeliveryMarker(ws);
    });
    const { session, onPartial, onSpeechStart, onTranscript } = scenario;
    await scenario.waitForDelivery();
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    session.close();

    expect(onPartial).toHaveBeenCalledWith("delete everything");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("preserves identical transcripts from consecutive utterances", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
      sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
      sendDeliveryMarker(ws);
    });
    await scenario.waitForDelivery();
    scenario.session.close();
    expect(scenario.onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("flushes finalized text returned after a client finalize request", async () => {
    using scenario = await createFinalizationScenario(true);
    const { session, onTranscript } = scenario;
    session.close();
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("good bye"));
  });

  it("flushes finalized text once when finalize produces no result", async () => {
    using scenario = await createFinalizationScenario(false);
    const { session, onPartial, onTranscript } = scenario;

    try {
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("good bye"));
      vi.useFakeTimers();
      session.close();
      session.close();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(scenario.onFinalize).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("good");
    } finally {
      if (vi.isFakeTimers()) {
        session.close();
      } else {
        // A failed observation can leave finalized text; close must own its fallback clock.
        vi.useFakeTimers();
        session.close();
        await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      }
    }
  });

  it("does not commit a turn on an utterance-end gap before speech-final", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, { text: "still", isFinal: true });
      ws.send(JSON.stringify({ type: "UtteranceEnd" }));
      sendResult(ws, { text: "speaking", isFinal: true, speechFinal: true });
    }, 25);
    const { session, onPartial, onTranscript } = scenario;
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("still speaking"));
    session.close();
    expect(onPartial).toHaveBeenCalledWith("still");
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not infer silence from a gap between provisional results", async () => {
    vi.useFakeTimers();
    let socket: WebSocket | undefined;
    using scenario = await createScenario((ws) => {
      socket = ws;
      sendResult(ws, { text: "still speaking" });
    }, 25);
    const { session, onPartial, onTranscript } = scenario;
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("still speaking"));
    await vi.advanceTimersByTimeAsync(350);
    expect(onTranscript).not.toHaveBeenCalled();
    sendResult(socket!, { text: "continuous speech", isFinal: true, speechFinal: true });
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("continuous speech"));
    session.close();
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "discards provisional speech", isFinal: false, expected: [["new"]] },
    {
      name: "preserves finalized speech as a separate turn",
      isFinal: true,
      expected: [["old"], ["new"]],
    },
  ])("$name when the provider reconnects", async ({ isFinal, expected }) => {
    vi.useFakeTimers();
    let connectionCount = 0;
    using scenario = await createScenario((ws) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        sendResult(ws, { text: "old", isFinal });
        ws.close();
        return;
      }
      sendResult(ws, { text: "new", isFinal: true, speechFinal: true });
    }, 10_000);
    const { session, onTranscript } = scenario;
    // Observe the real socket close before advancing the provider's retry delay.
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(expected.length), {
      timeout: 3000,
    });
    session.close();
    expect(onTranscript.mock.calls).toEqual(expected);
  });

  it("terminates instead of retaining an oversized utterance", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, { text: "x".repeat(256 * 1024), isFinal: true });
      sendResult(ws, { text: "y" });
    });
    const { session, onError } = scenario;
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("retained transcript exceeded"),
        }),
      ),
    );
    expect(session.isConnected()).toBe(false);
  });
});
