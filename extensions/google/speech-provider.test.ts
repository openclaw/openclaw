import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const transcode = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/media-runtime", async () => ({
  canonicalizeBase64: (await import("@openclaw/media-core/base64")).canonicalizeBase64,
  transcodeAudioBufferToOpus: transcode,
}));
const { assertOkOrThrowProviderErrorMock, postJsonRequestMock: post } = getProviderHttpMocks();
let buildGoogleSpeechProvider: typeof import("./speech-provider.js").buildGoogleSpeechProvider;
beforeAll(async () => {
  ({ buildGoogleSpeechProvider } = await import("./speech-provider.js"));
});
installProviderHttpMockCleanup();

const PCM = Buffer.from([1, 0, 2, 0]);
const MODEL = "gemini-3.8-flash-tts";
const LEGACY = "gemini-3.1-flash-tts-preview";
const SPEAKERS = [
  { speaker: "Puck", voice: "Puck" },
  { speaker: "Kore", voice: "Kore" },
];
const DIALOGUE = { apiKey: "test-key", model: MODEL, speakers: SPEAKERS };
const PROFILE = [
  "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
  "as performance direction. Do not read section titles, notes, labels, or",
  "configuration aloud.",
  "",
  "# AUDIO PROFILE: Alfred",
  "",
  "### DIRECTOR'S NOTES",
  "Provider notes:",
  "Keep a close-mic feel.",
  "",
  "### TRANSCRIPT",
].join("\n");
function request(overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest {
  return {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "google-test-key" },
    target: "audio-file",
    timeoutMs: 10_000,
    ...overrides,
  };
}
function synthesize(overrides: Partial<SpeechSynthesisRequest> = {}) {
  return buildGoogleSpeechProvider().synthesize(request(overrides));
}
function googleConfig(google: { apiKey?: string; baseUrl: string }): SpeechSynthesisRequest["cfg"] {
  return { models: { providers: { google: { models: [], ...google } } } };
}
function audioResponse(audio: Buffer | string = PCM) {
  const data = typeof audio === "string" ? audio : audio.toString("base64");
  return Response.json({
    steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/l16", data }] }],
    candidates: [
      {
        content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data } }] },
      },
    ],
  });
}
function responseResult(response: Response) {
  return { response, release: vi.fn(async () => {}) };
}
function recorded(): Record<string, unknown> {
  const actual = requireFirstPostJsonRecordRequest(post, "Google TTS request");
  return {
    ...actual,
    headers:
      actual.headers instanceof Headers ? Object.fromEntries(actual.headers) : actual.headers,
  };
}
function speechContent(text: string, speaker: string, style?: string) {
  return {
    type: "text",
    text,
    annotations: [{ type: "speech_metadata", speaker, ...(style ? { style } : {}) }],
  };
}

beforeEach(() => {
  post.mockImplementation(async () => responseResult(audioResponse()));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  transcode.mockReset();
});
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/media-runtime");
  vi.resetModules();
});

describe("Google speech provider", () => {
  it("decodes URL-safe Gemini audio as WAV and preserves audio tags", async () => {
    const pcm = Buffer.from([0xfb, 0xff, 8, 0, 9, 0, 10, 0]);
    post.mockImplementation(async () => responseResult(audioResponse(pcm.toString("base64url"))));
    const result = await synthesize({
      text: "[whispers] The door is open.",
      timeoutMs: 12_345,
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voiceName: "Puck",
      },
    });
    const actual = recorded();
    expect(actual).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${LEGACY}:generateContent`,
      fetchFn: fetch,
      pinDns: false,
      timeoutMs: 12_345,
    });
    expect(actual.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "[whispers] The door is open." }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
      },
    });
    expect(actual.headers).toMatchObject({ "x-goog-api-key": "google-test-key" });
    expect(result).toMatchObject({
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(result.audioBuffer.readUInt32LE(24)).toBe(24_000);
    expect(result.audioBuffer.subarray(44)).toEqual(pcm);
    expect(transcode).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledOnce();
  });

  it("bounds oversized success JSON, cancels and releases both attempts", async () => {
    const cancel = vi.fn();
    const release = vi.fn(async () => {});
    post.mockImplementation(async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      );
      Object.defineProperty(response, "json", {
        value: async () => {
          throw new Error("unbounded json reader was used");
        },
      });
      return { response, release };
    });
    await expect(synthesize({ timeoutMs: 12_000 })).rejects.toThrow(
      "Google TTS response: JSON response exceeds 16777216 bytes",
    );
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("renders deterministic audio-profile prompts idempotently", async () => {
    const provider = buildGoogleSpeechProvider();
    const context = {
      ...request(),
      providerConfig: {
        model: LEGACY,
        promptTemplate: "audio-profile-v1",
        personaPrompt: "Keep a close-mic feel.",
      },
      persona: { id: "alfred", label: "Alfred" },
    };
    const prepared = await provider.prepareSynthesis?.({
      ...context,
      text: "[whispers] The door is open.",
    });
    expect(prepared?.text).toBe(`${PROFILE}\n[whispers] The door is open.`);
    expect(
      await provider.prepareSynthesis?.({
        ...context,
        text: `${PROFILE}\n[whispers] The door is open.`,
      }),
    ).toBeUndefined();
  });

  it("retries once when Gemini returns no audio payload", async () => {
    post.mockResolvedValueOnce(
      responseResult(
        Response.json({ candidates: [{ content: { parts: [{ text: "not audio" }] } }] }),
      ),
    );
    const result = await synthesize({ timeoutMs: 5_000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(PCM);
  });

  it.each([
    { label: "non-canonical pad bits", data: "ZE==" },
    { label: "mixed alphabet", data: "aGVsbG8+_" },
  ])("rejects base64 with $label", async ({ data }) => {
    post.mockImplementation(async () => responseResult(audioResponse(data)));
    await expect(synthesize({ timeoutMs: 5_000 })).rejects.toThrow(
      "Google TTS response returned malformed base64 audio data",
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("retries an aborted fetch", async () => {
    post.mockRejectedValueOnce(
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    );
    const result = await synthesize({ timeoutMs: 5_000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(PCM);
  });

  it("falls back to GEMINI_API_KEY and the configured base URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-google-key");
    expect(buildGoogleSpeechProvider().isConfigured({ providerConfig: {}, timeoutMs: 1 })).toBe(
      true,
    );
    await synthesize({
      providerConfig: {},
      target: "voice-note",
      cfg: googleConfig({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }),
    });
    expect(recorded()).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${LEGACY}:generateContent`,
      headers: { "x-goog-api-key": "env-google-key" },
    });
  });

  it("uses the canonical endpoint for a whitespace-only base URL", async () => {
    await synthesize({ cfg: googleConfig({ baseUrl: "   " }) });
    expect(recorded()).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${LEGACY}:generateContent`,
      headers: { "x-goog-api-client": expect.stringMatching(/^openclaw\//u) },
    });
  });

  it("reuses the configured model-provider key without auth profiles", async () => {
    const cfg = googleConfig({
      apiKey: "model-provider-google-key",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(
      buildGoogleSpeechProvider().isConfigured({ cfg, providerConfig: {}, timeoutMs: 1 }),
    ).toBe(true);
    await synthesize({ cfg, providerConfig: {} });
    expect(recorded().headers).toMatchObject({ "x-goog-api-key": "model-provider-google-key" });
  });

  it("returns telephony PCM with per-call voice, model and profile overrides", async () => {
    const result = await buildGoogleSpeechProvider().synthesizeTelephony?.({
      ...request(),
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voice: "Kore",
        audioProfile: "Speak calmly.",
        speakerName: "Default speaker",
      },
      providerOverrides: {
        model: "google/gemini-3.1-pro-tts",
        voiceName: "Puck",
        audioProfile: "Speak brightly.",
        speakerName: "Override speaker",
      },
    });
    expect(recorded()).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-tts:generateContent",
    });
    expect(recorded().body).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "Speak brightly.\n\nSpeaker name: Override speaker\n\nhello" }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
      },
    });
    expect(result).toEqual({ audioBuffer: PCM, outputFormat: "pcm", sampleRate: 24_000 });
  });

  it("resolves provider config and directive overrides", () => {
    const provider = buildGoogleSpeechProvider();
    expect(
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: {
          providers: {
            google: {
              apiKey: "configured-key",
              model: `google/${LEGACY}`,
              voice: "Leda",
              audioProfile: "Speak warmly.",
              speakerName: "Narrator",
            },
          },
        },
        timeoutMs: 1,
      }),
    ).toEqual({
      apiKey: "configured-key",
      audioProfile: "Speak warmly.",
      baseUrl: undefined,
      model: LEGACY,
      speakerName: "Narrator",
      voiceName: "Leda",
    });
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };
    expect(provider.parseDirectiveToken?.({ key: "google_voice", value: "Aoede", policy })).toEqual(
      { handled: true, overrides: { voiceName: "Aoede" } },
    );
    expect(provider.parseDirectiveToken?.({ key: "google_model", value: LEGACY, policy })).toEqual({
      handled: true,
      overrides: { model: LEGACY },
    });
  });

  it("propagates structured HTTP failures and releases the response", async () => {
    const error = new Error(
      "Google TTS failed (429): Quota exceeded [code=RESOURCE_EXHAUSTED] [request_id=google_req_123]",
    );
    assertOkOrThrowProviderErrorMock.mockRejectedValue(error);
    const result = responseResult(
      Response.json(
        { error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
        { status: 429, headers: { "x-request-id": "google_req_123" } },
      ),
    );
    post.mockResolvedValue(result);
    await expect(synthesize()).rejects.toBe(error);
    expect(result.release).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
  });

  it("sends Gemini 3.8 style as metadata and preserves the transcript verbatim", async () => {
    const text = "[whispers] Status update starts now.";
    expect(
      await buildGoogleSpeechProvider().prepareSynthesis?.({
        ...request({ text }),
        providerConfig: {
          model: "gemini-3.8-flash-lite-tts",
          promptTemplate: "audio-profile-v1",
          personaPrompt: "Keep a close-mic feel.",
        },
        persona: { id: "alfred", label: "Alfred" },
      }),
    ).toBeUndefined();
    await synthesize({
      text,
      providerConfig: {
        apiKey: "google-test-key",
        model: "gemini-3.8-flash-lite-tts",
        audioProfile: "Speak professionally with a calm executive tone.",
        speakerName: "Alex",
        personaPrompt: "Keep a close-mic feel.",
      },
    });
    expect(recorded()).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/interactions",
      body: {
        model: "gemini-3.8-flash-lite-tts",
        store: false,
        input: [
          {
            type: "user_input",
            content: [
              speechContent(
                text,
                "Alex",
                "Speak professionally with a calm executive tone.\n\nKeep a close-mic feel.",
              ),
            ],
          },
        ],
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
        generation_config: { speech_config: [{ voice: "Kore" }] },
      },
    });
    expect(JSON.stringify(recorded())).not.toMatch(/Alfred|Speaker name|Persona/u);
  });

  it("extracts the wrapped transcript without stripping a marker in its text", async () => {
    const text = "Before the marker. ### TRANSCRIPT After the marker.";
    const prepared = await buildGoogleSpeechProvider().prepareSynthesis?.({
      ...request(),
      text: `${PROFILE}\n${text}`,
      providerConfig: { model: MODEL },
    });
    expect(prepared?.text).toBe(text);
  });

  it("fails closed for unsupported Gemini 3.8 model ids", async () => {
    await expect(
      synthesize({
        providerConfig: { apiKey: "google-test-key", model: "gemini-3.8-flash-tts-preview" },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Interactions API/u);
    expect(post).not.toHaveBeenCalled();
  });

  it("strips the Gemini 3.8 WAV container for telephony", async () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVEfmt "),
      Buffer.from([16, 0, 0, 0, 1, 0, 1, 0]),
      Buffer.alloc(12),
      Buffer.from("data"),
      Buffer.from([PCM.length, 0, 0, 0]),
      PCM,
    ]);
    wav.writeUInt32LE(wav.length - 8, 4);
    post.mockImplementation(async () =>
      responseResult(
        Response.json({
          steps: [
            {
              type: "model_output",
              content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }],
            },
          ],
        }),
      ),
    );
    expect(
      await buildGoogleSpeechProvider().synthesizeTelephony?.({
        ...request(),
        providerConfig: { apiKey: "google-test-key", model: MODEL },
      }),
    ).toEqual({ audioBuffer: PCM, outputFormat: "pcm", sampleRate: 24_000 });
  });

  it("sends compact and spaced labels as two styled conversational speakers", async () => {
    await synthesize({
      text: "Puck:Headphones on. <laugh> We opened it.\nKore: It is waiting at the maintainer gate.",
      providerConfig: {
        ...DIALOGUE,
        audioProfile: "Keep it brief.",
        speakers: [
          { ...SPEAKERS[0], style: "bright" },
          { ...SPEAKERS[1], style: "whispered" },
        ],
      },
    });
    expect(recorded()).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/interactions",
      body: {
        model: MODEL,
        store: false,
        input: [
          {
            type: "user_input",
            content: [
              speechContent(
                "Headphones on. <laugh> We opened it.",
                "Puck",
                "bright\n\nKeep it brief.",
              ),
              speechContent(
                "It is waiting at the maintainer gate.",
                "Kore",
                "whispered\n\nKeep it brief.",
              ),
            ],
          },
        ],
        generation_config: { speech_config: { mode: "conversational", speakers: SPEAKERS } },
      },
    });
  });

  it("keeps an unlabeled transcript on the single-voice path", async () => {
    await synthesize({
      text: "Just one voice for this sentence.",
      providerConfig: { ...DIALOGUE, voiceName: "Leda" },
    });
    expect(recorded()).toMatchObject({
      body: {
        input: [
          {
            type: "user_input",
            content: [{ type: "text", text: "Just one voice for this sentence." }],
          },
        ],
        generation_config: { speech_config: [{ voice: "Leda" }] },
      },
    });
    expect(JSON.stringify(recorded())).not.toContain("annotations");
  });

  it("rejects a two-speaker dialogue on Gemini 3.1 preview TTS", async () => {
    await expect(
      synthesize({
        text: "Puck: Hello.\nKore: Hello.",
        providerConfig: { ...DIALOGUE, model: LEGACY },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/gemini-3\.8-flash-tts/u);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    {
      position: "before the first speaker",
      text: "Intro: Today's agenda\nPuck: Hello.\nKore: Hi.",
      spoken: "Intro: Today's agenda Hello.",
      reply: "Hi.",
    },
    {
      position: "after a speaker",
      text: "Puck: Hello from the gate.\nAlice: Hi.\nKore: I will be there.",
      spoken: "Hello from the gate. Alice: Hi.",
      reply: "I will be there.",
    },
  ])("speaks unconfigured labels $position", async ({ text, spoken, reply }) => {
    await synthesize({ text, providerConfig: DIALOGUE });
    expect(recorded()).toMatchObject({
      body: {
        input: [
          {
            type: "user_input",
            content: [speechContent(spoken, "Puck"), speechContent(reply, "Kore")],
          },
        ],
        generation_config: { speech_config: { speakers: SPEAKERS } },
      },
    });
  });
});
