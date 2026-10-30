import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";
import { createSocketServer } from "./websocket.test-support.js";

const provider = buildDeepgramRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

async function createScenario(onConnection: (ws: WebSocket) => void, endpointingMs?: number) {
  const { baseUrl, requests } = await createSocketServer(onConnection, "/deepgram/v1");
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
    requests,
    [Symbol.dispose]: () => session.close(),
    waitForDelivery: () =>
      vi.waitFor(() =>
        expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(new Error("frames delivered")),
      ),
  };
}

type Result = [text: string, final?: boolean, speechFinal?: boolean, fromFinalize?: boolean];
type Frame = Result | "SpeechStarted" | "UtteranceEnd";
function sendResult(ws: WebSocket, [text, final = false, end = false, flush = false]: Result) {
  ws.send(
    JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: text }] },
      is_final: final,
      speech_final: end,
      from_finalize: flush,
    }),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("normalizes nested config and connects through an explicit HTTP base URL", async () => {
  const { baseUrl, requests } = await createSocketServer(() => {}, "/deepgram/v1");
  const deepgram = {
    apiKey: "dg-key",
    baseUrl,
    model: "nova-3",
    language: "en-US",
    encoding: "g711_ulaw",
    sample_rate: "8000",
    interim_results: "true",
    endpointing: "500",
  };
  const providerConfig =
    provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: { providers: { deepgram } },
    }) ?? {};
  const session = provider.createSession({ providerConfig });
  await session.connect();
  session.close();
  const { url, headers } = requests[0]!;
  expect(url.pathname).toBe("/deepgram/v1/listen");
  expect(url.searchParams.toString()).toBe(
    "model=nova-3&encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=500&language=en-US",
  );
  expect(headers.authorization).toBe("Token dg-key");
});

const privateUrlConfig = { apiKey: "key", baseUrl: "ftp://host/secret" };
it.each([
  ["API_KEY", "", {}, /^Deepgram API key missing$/],
  ["BASE_URL", "!", { apiKey: "key" }, /^Invalid Deepgram baseUrl: value is not a valid URL$/],
  ["BASE_URL", "", privateUrlConfig, /^(?!.*secret)Invalid Deepgram baseUrl: unsupported scheme/],
] as const)("validates DEEPGRAM_%s=%s", (env, value, providerConfig, error) => {
  vi.stubEnv(`DEEPGRAM_${env}`, value);
  expect(() => provider.createSession({ providerConfig })).toThrow(error);
});

const yes: Result = ["yes", true, true];
const turns: [string, Frame[], string[], string[], number][] = [
  ["rejects tails", [["partial"], ["", true, true], "SpeechStarted"], ["partial"], [], 2],
  ["repeats", [yes, yes], [], ["yes", "yes"], 2],
  ["ignores gaps", [["a", true], "UtteranceEnd", ["b", true, true]], ["a"], ["a b"], 1],
];
it.each(turns)("%s", async (_name, frames, partials, transcripts, starts) => {
  using scenario = await createScenario((ws) => {
    for (const frame of frames) {
      if (typeof frame === "string") {
        ws.send(JSON.stringify({ type: frame }));
      } else {
        sendResult(ws, frame);
      }
    }
    ws.send(JSON.stringify({ type: "Error", message: "frames delivered" }));
  });
  await scenario.waitForDelivery();
  scenario.session.close();
  expect(scenario.onPartial.mock.calls.flat()).toEqual(partials);
  expect(scenario.onTranscript.mock.calls.flat()).toEqual(transcripts);
  expect(scenario.onSpeechStart).toHaveBeenCalledTimes(starts);
  expect(scenario.requests[0]?.url.searchParams.get("endpointing")).toBe("800");
  expect(scenario.requests[0]?.url.searchParams.get("model")).toBe("nova-3");
});

it.each([true, false])("finalizes once with provider reply=%s", async (reply) => {
  const onFinalize = vi.fn();
  using scenario = await createScenario((ws) => {
    sendResult(ws, ["good", true]);
    sendResult(ws, ["bye"]);
    ws.on("message", (data) => {
      const message: { type?: string } = JSON.parse(rawDataToString(data, "utf8"));
      if (message.type !== "Finalize") {
        return;
      }
      onFinalize();
      if (reply) {
        sendResult(ws, ["bye", true, false, true]);
      }
    });
  }, 10_000);
  try {
    await vi.waitFor(() => expect(scenario.onPartial).toHaveBeenCalledWith("good bye"));
    vi.useFakeTimers();
    scenario.session.close();
    scenario.session.close();
    await (reply
      ? vi.waitFor(() => expect(scenario.onTranscript).toHaveBeenCalledExactlyOnceWith("good bye"))
      : vi.advanceTimersByTimeAsync(5_000));
    expect(scenario.onTranscript).toHaveBeenCalledExactlyOnceWith(reply ? "good bye" : "good");
    expect(onFinalize).toHaveBeenCalledTimes(1);
  } finally {
    // Failed delivery observations still close with a bounded fallback clock.
    vi.useFakeTimers();
    scenario.session.close();
    await vi.advanceTimersByTimeAsync(5_000);
  }
});

it("does not infer silence from a gap between provisional results", async () => {
  vi.useFakeTimers();
  let socket: WebSocket | undefined;
  using scenario = await createScenario((ws) => {
    socket = ws;
    sendResult(ws, ["still speaking"]);
  }, 25);
  const { session, onPartial, onTranscript } = scenario;
  await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("still speaking"));
  await vi.advanceTimersByTimeAsync(350);
  expect(onTranscript).not.toHaveBeenCalled();
  sendResult(socket!, ["continuous speech", true, true]);
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
      sendResult(ws, ["old", isFinal]);
      ws.close();
      return;
    }
    sendResult(ws, ["new", true, true]);
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
    sendResult(ws, ["x".repeat(256 * 1024), true]);
    sendResult(ws, ["y"]);
  });
  const { session, onError } = scenario;
  await vi.waitFor(() =>
    expect(onError.mock.calls[0]?.[0].message).toContain("retained transcript exceeded"),
  );
  expect(session.isConnected()).toBe(false);
});
