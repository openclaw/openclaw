import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TalkCatalogResultSchema, TalkSessionCloseParamsSchema } from "./channels.js";

describe("TalkSessionCloseParamsSchema", () => {
  it.each([undefined, "abort", "detach"])("accepts close disposition %s", (disposition) => {
    expect(
      Value.Check(TalkSessionCloseParamsSchema, {
        sessionId: "relay-1",
        ...(disposition ? { disposition } : {}),
      }),
    ).toBe(true);
  });

  it.each(["cancel", "", null, true])("rejects close disposition %s", (disposition) => {
    expect(Value.Check(TalkSessionCloseParamsSchema, { sessionId: "relay-1", disposition })).toBe(
      false,
    );
  });
});

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
});
