import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import * as catalog from "./capability-offers.js";
import { readGoogleSpeechConfig, synthesizeGoogleSpeech } from "./speech-google.js";

const preview = "gemini-2.5-flash-preview-tts",
  stable = "gemini-3.8-flash-tts";
const samples = Buffer.from([0, 0, 255, 127]);
const block = () => ({
  mimeType: "audio/L16;codec=pcm;rate=24000",
  data: samples.toString("base64"),
});
type Candidate = {
  finishReason: string;
  content: { role: string; parts: [{ inlineData: ReturnType<typeof block> }] };
};
const generated = (): { candidates: [Candidate] } => ({
  candidates: [
    { finishReason: "STOP", content: { role: "model", parts: [{ inlineData: block() }] } },
  ],
});
const interaction = (): {
  status: string;
  model: string;
  steps: [{ type: string; content: [{ type: string; mime_type: string; data: string }] }];
} => ({
  status: "completed",
  model: stable,
  steps: [
    {
      type: "model_output",
      content: [{ type: "audio", mime_type: "audio/l16", data: samples.toString("base64") }],
    },
  ],
});

function fixture(model = preview) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T12:00:00Z"));
  const interactions = model.startsWith("gemini-3.8-");
  const endpoint = interactions ? "speech_interactions" : "speech_generate_content";
  const offer: catalog.ClawRouterCapabilityOffer = {
    providerId: "google-gemini",
    endpoint,
    path: interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent",
    url: interactions
      ? "https://router.example/v1/proxy/google-gemini/speech_interactions"
      : `https://router.example/v1/native/google-gemini/v1beta/models/${model}:generateContent`,
    routeKind: interactions ? "manifest" : "native",
    methods: ["POST"],
    requestFormat: "google." + endpoint,
    responseFormat: "google." + endpoint,
    model: { id: "google/" + model, upstream: model, capabilities: ["audio.speech"] },
  };
  const discover = vi.spyOn(catalog, "fetchClawRouterCapabilityOffers").mockResolvedValue([offer]);
  const response = {
    payload: interactions ? (interaction() as unknown) : (generated() as unknown),
    status: 200,
    headers: { "content-type": "application/json" } as Record<string, string>,
    raw: undefined as Uint8Array<ArrayBuffer> | undefined,
  };
  const calls: Parameters<PluginCapabilityCatalogContext["fetchWithSsrFGuard"]>[0][] = [];
  const release = vi.fn(async () => {});
  const fetchWithSsrFGuard: PluginCapabilityCatalogContext["fetchWithSsrFGuard"] = async (
    options,
  ) => {
    options.beforeRequest?.();
    calls.push(options);
    return {
      response: new Response(response.raw ?? JSON.stringify(response.payload), {
        status: response.status,
        headers: response.headers,
      }),
      release,
      finalUrl: options.url,
    };
  };
  const cfg = {
    models: {
      providers: {
        clawrouter: {
          baseUrl: "https://router.example/v1",
          models: [],
          apiKey: "synthetic-router",
        },
      },
    },
  };
  const resolveContext = vi.fn(async () =>
    catalog.resolveClawRouterCapabilityHttpContext(cfg, "synthetic-router", "audio"),
  );
  const request: SpeechSynthesisRequest = {
    cfg,
    providerConfig: { upstreamProvider: "google", model: "google/" + model, voice: "Kore" },
    text: "Synthetic speech",
    target: "audio-file",
    timeoutMs: 5000,
  };
  const run = (changes: Partial<SpeechSynthesisRequest> = {}) =>
    synthesizeGoogleSpeech({
      request: { ...request, ...changes },
      resolveContext,
      fetchWithSsrFGuard,
      remaining: () => 5000,
    });
  return { offer, discover, response, calls, release, request, resolveContext, run };
}
afterEach(() => vi.restoreAllMocks());

describe("ClawRouter Google speech codec and admission", () => {
  it.each([preview, stable])(
    "encodes %s and concatenates all validated PCM into one checked WAV",
    async (model) => {
      const f = fixture(model);
      if (model === preview) {
        f.response.payload = {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ inlineData: block() }, { inlineData: block() }] },
            },
          ],
        };
      } else {
        f.response.payload = {
          ...interaction(),
          steps: [
            {
              type: "model_output",
              content: [
                { type: "audio", data: "AAD/fw==" },
                { type: "audio", data: "AAD/fw==" },
              ],
            },
          ],
        };
      }
      const result = await f.run();
      expect(result).toMatchObject({
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      });
      expect(result.audioBuffer.toString("hex")).toBe(
        "524946462c00000057415645666d74201000000001000100c05d000080bb00000200100064617461080000000000ff7f0000ff7f",
      );
      expect(f.calls).toHaveLength(1);
      expect(new Headers(f.calls[0]?.init?.headers).get("authorization")).toBe(
        "Bearer synthetic-router",
      );
      const body = f.calls[0]?.init?.body;
      assert(typeof body === "string");
      expect(JSON.parse(body)).toEqual(
        model === preview
          ? {
              contents: [{ role: "user", parts: [{ text: "Synthetic speech" }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
              },
            }
          : {
              body: {
                model: stable,
                store: false,
                input: [
                  { type: "user_input", content: [{ type: "text", text: "Synthetic speech" }] },
                ],
                generation_config: { speech_config: [{ voice: "Kore" }] },
                response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
              },
            },
      );
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { model: "openai/tts-1" },
    { voice: undefined },
    { voiceId: "Puck" },
    { voiceName: "Puck" },
    { modelId: "google/" + stable },
    { speed: 1 },
    { body: {} },
    { instructions: "extra" },
    { responseFormat: "pcm" },
  ])("rejects ambiguous or unsupported config before auth/discovery: %j", async (invalid) => {
    const f = fixture();
    await expect(
      f.run({ providerConfig: { ...f.request.providerConfig, ...invalid } }),
    ).rejects.toThrow();
    expect(f.resolveContext).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it("does not inherit default voices and permits a single unambiguous override", async () => {
    const f = fixture();
    expect(() =>
      readGoogleSpeechConfig({ upstreamProvider: "google", model: "google/" + preview }),
    ).toThrow("explicit single voice");
    await f.run({ providerOverrides: { speakerVoiceId: "Puck", modelId: "google/" + preview } });
    const requestBody = f.calls[0]?.init?.body;
    assert(typeof requestBody === "string");
    const body = JSON.parse(requestBody);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      "Puck",
    );
    await expect(f.run({ providerOverrides: { apiKey: "different-owner" } })).rejects.toThrow();
  });

  it("denies all three previews at the exact cutoff while Interactions remains selectable", () => {
    fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-17T00:00:00Z"));
    for (const model of ["gemini-3.1-flash-tts-preview", preview, "gemini-2.5-pro-preview-tts"]) {
      expect(() => readGoogleSpeechConfig({ model: "google/" + model, voice: "Kore" })).toThrow(
        "expired",
      );
    }
    expect(readGoogleSpeechConfig({ model: "google/" + stable, voice: "Kore" }).model).toBe(
      "google/" + stable,
    );
  });

  it.each(["foreign", "vendor-alias", "endpoint", "format", "route", "model", "duplicate"])(
    "refuses %s offers without a paid POST",
    async (invalid) => {
      const f = fixture();
      if (invalid === "foreign") {
        f.offer.providerId = "openai";
      }
      if (invalid === "vendor-alias") {
        f.offer.providerId = "google";
      }
      if (invalid === "endpoint") {
        f.offer.endpoint = "generate";
      }
      if (invalid === "format") {
        f.offer.responseFormat = "audio.binary";
      }
      if (invalid === "route") {
        f.offer.routeKind = "manifest";
      }
      if (invalid === "model") {
        f.offer.model = {
          id: "google/" + preview,
          upstream: stable,
          capabilities: ["audio.speech"],
        };
      }
      if (invalid === "duplicate") {
        f.discover.mockResolvedValue([f.offer, { ...f.offer }]);
      }
      await expect(f.run()).rejects.toThrow("one eligible");
      expect(f.calls).toHaveLength(0);
    },
  );

  it.each([
    "base64",
    "odd",
    "empty",
    "rate",
    "duplicate-mime",
    "wav",
    "finish",
    "second-candidate",
    "model",
    "error",
  ])("validates the complete response, including %s failures", async (invalid) => {
    const f = fixture(),
      payload = generated();
    const later: Record<string, unknown> = block();
    payload.candidates[0].content.parts.push({ inlineData: later as ReturnType<typeof block> });
    if (invalid === "base64") {
      later.data = "AB==";
    }
    if (invalid === "odd") {
      later.data = "AA==";
    }
    if (invalid === "empty") {
      later.data = "";
    }
    if (invalid === "rate") {
      later.mimeType = "audio/l16;rate=16000";
    }
    if (invalid === "duplicate-mime") {
      later.mime_type = later.mimeType;
    }
    if (invalid === "wav") {
      later.mimeType = "audio/wav";
    }
    if (invalid === "finish") {
      payload.candidates[0].finishReason = "MAX_TOKENS";
    }
    if (invalid === "second-candidate") {
      payload.candidates.push(payload.candidates[0]);
    }
    f.response.payload =
      invalid === "model"
        ? { ...payload, modelVersion: stable }
        : invalid === "error"
          ? { ...payload, error: {} }
          : payload;
    await expect(f.run()).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["running", "wrong-model", "sdk-field", "later-audio", "later-error"])(
    "rejects incomplete/ambiguous raw REST Interactions: %s",
    async (invalid) => {
      const f = fixture(stable),
        payload = interaction();
      if (invalid === "running") {
        payload.status = "in_progress";
      }
      if (invalid === "wrong-model") {
        payload.model = preview;
      }
      if (invalid === "later-audio") {
        payload.steps[0].content.push({ type: "audio", mime_type: "audio/l16", data: "invalid" });
      }
      if (invalid === "later-error") {
        Object.assign(payload.steps[0].content[0], { error: { message: "synthetic failure" } });
      }
      f.response.payload =
        invalid === "sdk-field" ? { ...payload, output_audio: block() } : payload;
      await expect(f.run()).rejects.toThrow();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["utf8", "length", "truncated"])(
    "rejects malformed full JSON bytes: %s",
    async (failure) => {
      const f = fixture();
      const valid = JSON.stringify(generated());
      f.response.raw =
        failure === "utf8"
          ? Buffer.concat([
              Buffer.from(valid.slice(0, -1) + ',"extra":"'),
              Buffer.from([0xff]),
              Buffer.from('"}'),
            ])
          : Buffer.from(failure === "truncated" ? valid.slice(0, -1) : valid);
      if (failure === "length") {
        f.response.headers["content-length"] = String(f.response.raw.length + 1);
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("charges the WAV header to the configured audio limit and rejects aggregate overflow", async () => {
    const f = fixture();
    const payload = generated();
    payload.candidates[0].content.parts[0].inlineData.data = Buffer.alloc(
      8 * 1024 * 1024 - 42,
    ).toString("base64");
    f.response.payload = payload;
    await expect(f.run()).rejects.toThrow();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
