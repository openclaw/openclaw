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
  it("accepts optional family Settings facts with only declared Talk transports", () => {
    const catalog = catalogWithActiveVoicePolicy("allowlist-default");
    const modelFamilySettings = {
      family: "example-live",
      unlistedModelVoices: "active",
      unsupportedTransports: ["provider-websocket"],
      gatewayRelayHandlesAgentConsult: true,
      hint: {
        titleKey: "example.title",
        descriptionKey: "example.hint",
        readyKey: "example.ready",
      },
    };
    const withSettings = {
      ...catalog,
      realtime: {
        providers: [{ ...catalog.realtime.providers[0], modelFamilySettings }],
      },
    };

    expect(Value.Check(TalkCatalogResultSchema, catalog)).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, withSettings)).toBe(true);
    modelFamilySettings.unsupportedTransports = ["unknown-transport"];
    expect(Value.Check(TalkCatalogResultSchema, withSettings)).toBe(false);
  });

  it("accepts only the authoritative voice allowlist policy", () => {
    expect(
      Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("allowlist-default")),
    ).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("free-form"))).toBe(
      false,
    );
  });
});
