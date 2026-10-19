import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const { resolveApiKeyMock } = vi.hoisted(() => ({ resolveApiKeyMock: vi.fn() }));

// mock-isolation: Credential fallback is fixture-owned; never read real provider credentials.
vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: resolveApiKeyMock,
}));

import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildElevenLabsRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

function resolveConfig(config: Record<string, unknown>) {
  return provider.resolveConfig?.({ cfg: {}, rawConfig: { providers: { elevenlabs: config } } });
}

const sessions: ReturnType<typeof provider.createSession>[] = [];
function createSession(
  baseUrl: string,
  options: Partial<RealtimeTranscriptionSessionCreateRequest> = {},
) {
  const session = provider.createSession({
    ...options,
    providerConfig: { apiKey: "fixture-value", baseUrl, ...options.providerConfig },
  });
  sessions.push(session);
  return session;
}

const committed = { message_type: "committed_transcript", text: "yes" };
const timestamped = { message_type: "committed_transcript_with_timestamps", text: "yes" };
const committedNo = { ...committed, text: "no" };
const timestampedNo = { ...timestamped, text: "no" };
const partial = (text: string) => ({ message_type: "partial_transcript", text });

let cleanup: (() => Promise<void>) | undefined;

async function createRealtimeServer(
  onRequest: (url: URL) => void,
  options?: {
    initialEvent?: Record<string, unknown>;
    events?: readonly Record<string, unknown>[];
    eventsByConnection?: readonly (readonly Record<string, unknown>[])[];
    closeAfterEvents?: boolean;
  },
) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    onRequest(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify(options?.initialEvent ?? { message_type: "session_started" }));
      const events = options?.eventsByConnection?.[connectionCount] ?? options?.events ?? [];
      connectionCount += 1;
      for (const event of events) {
        ws.send(JSON.stringify(event));
      }
      if (options?.closeAfterEvents) {
        ws.close();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.close();
    }
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
    resolveApiKeyMock.mockReset();
  });

  it("normalizes nested provider config", () => {
    expect(
      resolveConfig({
        apiKey: "eleven-key",
        model_id: "scribe_v2_realtime",
        audio_format: "ulaw_8000",
        sample_rate: "8000",
        commit_strategy: "vad",
        language: "en",
      }),
    ).toEqual({
      apiKey: "eleven-key",
      baseUrl: undefined,
      modelId: undefined,
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const requests: URL[] = [];
    const baseUrl = await createRealtimeServer((url) => requests.push(url));
    const session = createSession(baseUrl, {
      providerConfig: {
        modelId: "scribe_v2_realtime",
        audioFormat: "ulaw_8000",
        sampleRate: 8000,
        commitStrategy: "vad",
        languageCode: "en",
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/speech-to-text/realtime");
    expect(requests[0]?.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(requests[0]?.searchParams.get("audio_format")).toBe("ulaw_8000");
    expect(requests[0]?.searchParams.get("commit_strategy")).toBe("vad");
    expect(requests[0]?.searchParams.get("language_code")).toBe("en");
  });

  it("reports ready-state input_error errors exactly once", async () => {
    const message = "legacy provider rejected the input";
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [{ message_type: "input_error", message }],
    });
    const onError = vi.fn();
    const session = createSession(baseUrl, { onError });
    await session.connect();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message })),
    );
  });

  it("rejects pre-ready provider errors with their original actionable detail", async () => {
    const message = "rate limit exceeded; retry after account reset";
    const baseUrl = await createRealtimeServer(() => undefined, {
      initialEvent: { message_type: "rate_limited", error: message },
      closeAfterEvents: true,
    });
    const onError = vi.fn();
    const session = createSession(baseUrl, { onError });

    await expect(session.connect()).rejects.toThrow(message);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
  });

  it.each<[string, (typeof committed)[], string[], string[]]>([
    ["preserves identical adjacent commits", [committed, committed], ["yes", "yes"], []],
    ["consumes one timestamp echo", [committed, timestamped, timestamped], ["yes", "yes"], []],
    ["preserves timestamp-only repeats", [timestamped, timestamped], ["yes", "yes"], []],
    ["preserves differing timestamp text", [committed, timestampedNo], ["yes", "no"], []],
    [
      "preserves delayed echoes across partials",
      [committed, partial("next turn"), timestamped, committed, timestamped],
      ["yes", "yes"],
      ["next turn"],
    ],
    [
      "pairs timestamps with alternating commits",
      [committed, timestamped, committedNo, timestampedNo, committed, timestamped],
      ["yes", "no", "yes"],
      [],
    ],
  ])("%s", async (_name, events, transcripts, partials) => {
    const deliveryMarker = "transcript frames delivered";
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [...events, partial(deliveryMarker)],
    });
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = createSession(baseUrl, { onError, onPartial, onSpeechStart, onTranscript });

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(deliveryMarker));
    expect(onPartial.mock.calls.map(([text]) => text)).toEqual([...partials, deliveryMarker]);
    expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(transcripts);
    expect(onError).not.toHaveBeenCalled();
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it("does not suppress a timestamp-only transcript from a replacement session", async () => {
    const firstMarker = "first session delivered";
    const secondMarker = "replacement session delivered";
    const baseUrl = await createRealtimeServer(() => undefined, {
      eventsByConnection: [
        [committed, partial(firstMarker)],
        [timestamped, partial(secondMarker)],
      ],
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = createSession(baseUrl, { onPartial, onTranscript });

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(firstMarker));
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("yes");

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(secondMarker));
    expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("rejects whitespace-only environment keys before session creation", async () => {
    resolveApiKeyMock.mockReturnValue(null);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XI_API_KEY", "   ");

    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig: {} })).toBe(false);
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "ElevenLabs API key missing",
    );
  });
});
