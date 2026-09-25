import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TalkCatalogResultSchema, TalkSessionCreateParamsSchema } from "./channels.js";

function catalogWithActiveVoicePolicy(activeVoiceSelectionPolicy: unknown) {
  return {
    modes: ["realtime"],
    transports: ["gateway-relay"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      providers: [
        {
          id: "realtime",
          label: "Realtime",
          configured: true,
          voices: ["provider-voice"],
          activeVoices: ["active-voice"],
          activeVoiceSelectionPolicy,
        },
      ],
    },
  };
}

describe("TalkCatalogResultSchema", () => {
  it("accepts only the authoritative voice allowlist policy", () => {
    expect(
      Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("allowlist-default")),
    ).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("free-form"))).toBe(
      false,
    );
  });

  it("accepts the negotiated command hint capability and rejects incompatible shapes", () => {
    const capability = {
      version: 1,
      kind: "local-stop-phrases",
      mode: "realtime",
      transport: "gateway-relay",
      models: ["gpt-realtime-2.1"],
      transcriptionModel: "gpt-4o-mini-transcribe",
      maxPhrases: 8,
      maxPhraseUtf16Units: 64,
      maxTotalUtf16Units: 256,
      maxPromptUtf8Bytes: 1024,
    };
    const catalog = catalogWithActiveVoicePolicy("allowlist-default");
    const provider = catalog.realtime.providers[0];
    const withCapability = (value: unknown) => ({
      ...catalog,
      realtime: { providers: [{ ...provider, transcriptionCommandHints: value }] },
    });
    expect(Value.Check(TalkCatalogResultSchema, catalog)).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, withCapability(capability))).toBe(true);
    for (const change of [
      { version: 2 },
      { kind: "free-form" },
      { mode: "transcription" },
      { transport: "webrtc" },
      { models: [] },
      { models: ["gpt-realtime-2.1", "other"] },
      { transcriptionModel: "whisper-1" },
      { maxPhrases: 9 },
      { maxPhraseUtf16Units: 65 },
      { maxTotalUtf16Units: 257 },
      { maxPromptUtf8Bytes: 1025 },
      { prompt: "unadvertised" },
    ]) {
      expect(
        Value.Check(TalkCatalogResultSchema, withCapability({ ...capability, ...change })),
      ).toBe(false);
    }
  });
});

describe("TalkSessionCreateParamsSchema transcription hints", () => {
  it("preserves old requests and accepts bounded literal phrase arrays", () => {
    expect(Value.Check(TalkSessionCreateParamsSchema, {})).toBe(true);
    for (const phrases of [[], ["stop talking", "end talking"], ["Arrête 🌍"], ["x".repeat(64)]]) {
      expect(
        Value.Check(TalkSessionCreateParamsSchema, {
          transcriptionHints: { version: 1, kind: "local-stop-phrases", phrases },
        }),
      ).toBe(true);
    }
  });

  it("rejects malformed hints and arbitrary transcription overrides", () => {
    const hints = { version: 1, kind: "local-stop-phrases", phrases: ["end talking"] };
    for (const transcriptionHints of [
      null,
      [],
      {},
      { ...hints, version: 2 },
      { ...hints, kind: "prompt" },
      { ...hints, phrases: "end talking" },
      { ...hints, phrases: [42] },
      { ...hints, phrases: [""] },
      { ...hints, phrases: ["x".repeat(65)] },
      { ...hints, phrases: Array(9).fill("end talking") },
      { ...hints, prompt: "arbitrary instructions" },
      { ...hints, model: "another-model" },
    ]) {
      expect(Value.Check(TalkSessionCreateParamsSchema, { transcriptionHints })).toBe(false);
    }
    expect(Value.Check(TalkSessionCreateParamsSchema, { transcriptionPrompt: "arbitrary" })).toBe(
      false,
    );
  });
});
