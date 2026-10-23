// Kokoro.cpp speech provider contracts against a loopback OpenAI-compatible server fixture.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type * as MediaRuntime from "openclaw/plugin-sdk/media-runtime";
import type { SpeechModelOverridePolicy } from "openclaw/plugin-sdk/speech-core";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKokoroCppSpeechProvider } from "./speech-provider.js";

const transcode = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof MediaRuntime>()),
  transcodeAudioBufferToOpus: transcode,
}));

type RecordedRequest = { method?: string; url?: string; body: string };
type Handler = (request: RecordedRequest, response: ServerResponse) => void;

const WAV_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, 1)]);
const PCM_BYTES = Buffer.from([0, 0, 0xff, 0x7f]);

const provider = buildKokoroCppSpeechProvider();
const requests: RecordedRequest[] = [];
let handler: Handler = (_request, response) => response.end();
let releasePort: () => Promise<void> = async () => {};
let baseUrl = "";

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const recorded = { method: request.method, url: request.url, body };
    requests.push(recorded);
    handler(recorded, response);
  });
});

function respondAudio(contentType: string, bytes: Buffer): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(bytes);
  };
}

function lastRequestBody(): unknown {
  return JSON.parse(requests.at(-1)?.body ?? "null");
}

const allowAll: SpeechModelOverridePolicy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

beforeAll(async () => {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  releasePort = () => claim.release();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(claim.port, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${claim.port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await releasePort();
});

beforeEach(() => {
  requests.length = 0;
  transcode.mockReset();
});

describe("kokoro.cpp speech provider config", () => {
  const resolve = (rawConfig: Record<string, unknown>) =>
    provider.resolveConfig?.({ cfg: {}, rawConfig, timeoutMs: 1000 });

  it("opts in only through an explicit kokoro-cpp provider entry", async () => {
    const missing = resolve({ providers: { openai: { apiKey: "x" } } }) ?? {};
    expect(missing).toEqual({});
    await expect(
      provider.isConfiguredAsync?.({ providerConfig: missing, timeoutMs: 1000 }),
    ).resolves.toBe(false);

    const defaults = resolve({ providers: { "kokoro-cpp": {} } }) ?? {};
    expect(defaults).toEqual({ baseUrl: "http://127.0.0.1:8880/v1", voice: "af_maple" });
    await expect(
      provider.isConfiguredAsync?.({ providerConfig: defaults, timeoutMs: 1000 }),
    ).resolves.toBe(true);
  });

  it("trims trailing slashes and rejects out-of-range speeds", () => {
    expect(resolve({ providers: { "kokoro-cpp": { baseUrl: "http://h:1/v1//" } } })).toEqual({
      baseUrl: "http://h:1/v1",
      voice: "af_maple",
    });
    expect(() => resolve({ providers: { "kokoro-cpp": { speed: 9 } } })).toThrow(
      "Invalid kokoro.cpp speed",
    );
  });
});

describe("kokoro.cpp speech synthesis", () => {
  const request = (target: "audio-file" | "voice-note") => ({
    text: "hello",
    cfg: {},
    providerConfig: { baseUrl, voice: "af_sol", speed: 1.5 },
    providerOverrides: { voice: "bf_vale" },
    target,
    timeoutMs: 5000,
  });

  it("requests WAV and returns it as an audio file", async () => {
    handler = respondAudio("audio/wav", WAV_BYTES);
    const result = await provider.synthesize(request("audio-file"));
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: "/v1/audio/speech" });
    expect(lastRequestBody()).toEqual({
      model: "kokoro",
      input: "hello",
      voice: "bf_vale",
      response_format: "wav",
      speed: 1.5,
    });
    expect(result).toEqual({
      audioBuffer: WAV_BYTES,
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
    expect(transcode).not.toHaveBeenCalled();
  });

  it("transcodes WAV to Opus for voice notes", async () => {
    handler = respondAudio("audio/wav", WAV_BYTES);
    transcode.mockResolvedValueOnce(Buffer.from("opus"));
    const result = await provider.synthesize(request("voice-note"));
    expect(transcode).toHaveBeenCalledWith({
      audioBuffer: WAV_BYTES,
      inputExtension: "wav",
      tempPrefix: "tts-kokoro-cpp-",
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("opus"),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
  });

  it("requests raw 24 kHz PCM for telephony", async () => {
    handler = respondAudio("audio/pcm", PCM_BYTES);
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {},
      providerConfig: { baseUrl },
      timeoutMs: 5000,
    });
    expect(lastRequestBody()).toEqual({
      model: "kokoro",
      input: "hello",
      voice: "af_maple",
      response_format: "pcm",
    });
    expect(result).toEqual({ audioBuffer: PCM_BYTES, outputFormat: "pcm", sampleRate: 24_000 });
  });

  it("surfaces the server's OpenAI-style error message", async () => {
    handler = (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Unknown voice 'zz'; GET /v1/audio/voices lists the available voices",
            type: "invalid_request_error",
            param: "voice",
            code: null,
          },
        }),
      );
    };
    await expect(
      provider.synthesize({ ...request("audio-file"), providerOverrides: { voice: "zz" } }),
    ).rejects.toThrow("Unknown voice 'zz'");
  });
});

describe("kokoro.cpp voices", () => {
  it("lists live voices with locale and gender from Kokoro voice prefixes", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ voices: ["af_maple", "dm_martin", "custom"] }));
    };
    await expect(
      provider.listVoices?.({ providerConfig: { baseUrl }, timeoutMs: 5000 }),
    ).resolves.toEqual([
      { id: "af_maple", name: "af_maple", locale: "en-US", gender: "female" },
      { id: "dm_martin", name: "dm_martin", locale: "de-DE", gender: "male" },
      { id: "custom", name: "custom" },
    ]);
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: "/v1/audio/voices" });
  });

  it("rejects a payload without a voices list", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    };
    await expect(provider.listVoices?.({ providerConfig: { baseUrl } })).rejects.toThrow(
      "returned no voices list",
    );
  });
});

describe("kokoro.cpp directives", () => {
  const parse = (key: string, value: string, policy = allowAll) =>
    provider.parseDirectiveToken?.({ key, value, policy });

  it("applies voice and speed directives within policy and range", () => {
    expect(parse("voice", "bf_vale", { ...allowAll, allowVoice: false })).toEqual({
      handled: true,
    });
    expect(parse("kokoro_voice", "bf_vale")).toEqual({
      handled: true,
      overrides: { voice: "bf_vale" },
    });
    expect(parse("speed", "9")).toEqual({
      handled: true,
      warnings: ['invalid kokoro.cpp speed "9" (0.25-4.0)'],
    });
    expect(parse("speed", "1.2")).toEqual({ handled: true, overrides: { speed: 1.2 } });
  });
});
