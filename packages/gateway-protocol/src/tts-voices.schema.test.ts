import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  TtsDesignVoiceResultSchema,
  TtsReplicateVoiceResultSchema,
  TtsVoicesResultSchema,
} from "./schema/tts-voices.js";

describe("TTS voice response contracts", () => {
  it("accepts stored, catalog, and legacy voices in the same listing", () => {
    const validate = Compile(TtsVoicesResultSchema);
    expect(
      validate.Check({
        provider: "google",
        voices: [
          { id: "stored-voice", name: "My voice", stored: true },
          { id: "Kore", stored: false },
          { id: "legacy-voice" },
        ],
        projectListingIncomplete: true,
      }),
    ).toBe(true);
    expect(validate.Check({ provider: "google", voices: [{ id: "voice", stored: "true" }] })).toBe(
      false,
    );
  });

  describe.each([
    { method: "design", schema: TtsDesignVoiceResultSchema, audio: { audioBase64: "YXVkaW8=" } },
    { method: "replicate", schema: TtsReplicateVoiceResultSchema, audio: {} },
  ])("$method", ({ schema, audio }) => {
    const validate = Compile(schema);
    const uncertain = {
      provider: "google",
      outcome: "uncertain",
      message: "Check the voice list before retrying.",
    };

    it("accepts an uncertain store without claiming a voice ID or preview", () => {
      expect(validate.Check(uncertain)).toBe(true);
    });

    it("accepts an explicitly confirmed successful Gateway response", () => {
      expect(
        validate.Check({ provider: "google", outcome: "stored", id: "stored-voice", ...audio }),
      ).toBe(true);
    });

    it("rejects ambiguous, incomplete, and contradictory store receipts", () => {
      for (const result of [
        { provider: "google", ...audio },
        { ...uncertain, message: undefined },
        { ...uncertain, outcome: "stored" },
        { ...uncertain, id: "stored-voice" },
        { ...uncertain, audioBase64: "YXVkaW8=" },
        { provider: "google", outcome: "stored", id: "", ...audio },
        { provider: "google", id: "stored-voice", ...audio },
      ]) {
        expect(validate.Check(result), JSON.stringify(result)).toBe(false);
      }
    });
  });

  it("requires a design preview but accepts replication with or without one", () => {
    const receipt = { provider: "google", outcome: "stored", id: "stored-voice" };
    expect(Compile(TtsDesignVoiceResultSchema).Check(receipt)).toBe(false);
    expect(
      Compile(TtsReplicateVoiceResultSchema).Check({ ...receipt, audioBase64: "YXVkaW8=" }),
    ).toBe(true);
  });
});
