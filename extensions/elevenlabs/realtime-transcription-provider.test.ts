import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";

const { resolveApiKeyMock } = vi.hoisted(() => ({ resolveApiKeyMock: vi.fn() }));

// mock-isolation: Credential fallback is fixture-owned; never read real provider credentials.
vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: resolveApiKeyMock,
}));

import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildElevenLabsRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

const committed = { message_type: "committed_transcript", text: "yes" };
const timestamped = { message_type: "committed_transcript_with_timestamps", text: "yes" };
const committedNo = { ...committed, text: "no" };
const timestampedNo = { ...timestamped, text: "no" };
const partial = (text: string) => ({ message_type: "partial_transcript", text });
const pair = [committed, timestamped];

let cleanup: (() => Promise<void>) | undefined;

async function createSession(
  eventsByConnection: Record<string, unknown>[][],
  sessionOptions: Partial<RealtimeTranscriptionSessionCreateRequest> = {},
  initialEvent = { message_type: "session_started" },
) {
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  const requests: URL[] = [];
  let connectionCount = 0;
  wss.on("connection", (ws, request) => {
    requests.push(new URL(request.url ?? "/", "http://127.0.0.1"));
    for (const event of [initialEvent, ...(eventsByConnection[connectionCount++] ?? [])]) {
      ws.send(JSON.stringify(event));
    }
    if (initialEvent.message_type !== "session_started") {
      ws.close();
    }
  });
  const port = await listenOnLoopback(server);
  const session = provider.createSession({
    ...sessionOptions,
    providerConfig: {
      ...sessionOptions.providerConfig,
      apiKey: sessionOptions.providerConfig?.apiKey ?? "fixture-value",
      baseUrl: sessionOptions.providerConfig?.baseUrl ?? `http://127.0.0.1:${port}`,
    },
  });
  cleanup = async () => {
    session.close();
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await promisify(wss.close.bind(wss))();
    await promisify(server.close.bind(server))();
  };
  return { session, requests };
}

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
    resolveApiKeyMock.mockReset();
  });

  it("normalizes nested config and connects with the configured URL params", async () => {
    const elevenlabs = {
      apiKey: "eleven-key",
      model_id: "scribe_v2_realtime",
      audio_format: "ulaw_8000",
      sample_rate: "8000",
      commit_strategy: "vad",
      language: "en",
    };
    const providerConfig = provider.resolveConfig?.({
      cfg: {},
      rawConfig: { providers: { elevenlabs } },
    });
    expect(providerConfig).toMatchObject({
      apiKey: "eleven-key",
      modelId: undefined,
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
    });
    const { session, requests } = await createSession([[]], {
      providerConfig: { ...providerConfig, modelId: "scribe_v2_realtime" },
    });
    await session.connect();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/speech-to-text/realtime");
    expect(requests[0]?.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(requests[0]?.searchParams.get("audio_format")).toBe("ulaw_8000");
    expect(requests[0]?.searchParams.get("commit_strategy")).toBe("vad");
    expect(requests[0]?.searchParams.get("language_code")).toBe("en");
  });

  it.each([false, true])(
    "reports provider errors exactly once (pre-ready: %s)",
    async (preReady) => {
      const message = "rate limit exceeded; retry after account reset";
      const event = preReady
        ? { message_type: "rate_limited", error: message }
        : { message_type: "input_error", message };
      const onError = vi.fn();
      const { session } = await createSession(
        [preReady ? [] : [event]],
        { onError },
        preReady ? event : undefined,
      );
      if (preReady) {
        await expect(session.connect()).rejects.toThrow(message);
      } else {
        await session.connect();
      }
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message })),
      );
    },
  );

  it.each<[string, (typeof committed)[][], string[][], string[]]>([
    ["adjacent commits", [[committed, committed]], [["yes", "yes"]], []],
    ["one timestamp echo", [[...pair, timestamped]], [["yes", "yes"]], []],
    ["timestamp-only repeats", [[timestamped, timestamped]], [["yes", "yes"]], []],
    ["differing timestamp text", [[committed, timestampedNo]], [["yes", "no"]], []],
    [
      "delayed echoes across partials",
      [[committed, partial("next turn"), timestamped, ...pair]],
      [["yes", "yes"]],
      ["next turn"],
    ],
    [
      "alternating commits",
      [[...pair, committedNo, timestampedNo, ...pair]],
      [["yes", "no", "yes"]],
      [],
    ],
    ["replacement session", [[committed], [timestamped]], [["yes"], ["yes", "yes"]], []],
  ])("preserves %s", async (_name, connections, transcripts, partials) => {
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const { session } = await createSession(
      connections.map((events, i) => [...events, partial(String(i))]),
      { onPartial, onTranscript },
    );
    for (let i = 0; i < connections.length; i++) {
      onPartial.mockClear();
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(String(i)));
      expect(onPartial.mock.calls.map(([text]) => text)).toEqual([...partials, String(i)]);
      expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(transcripts[i]);
    }
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
