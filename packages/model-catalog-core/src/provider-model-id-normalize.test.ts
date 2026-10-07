// Model Catalog Core tests cover provider model id normalize behavior.
import { describe, expect, it } from "vitest";
import {
  isOpenAIMessageEndCachedModelId,
  normalizeGooglePreviewModelId,
} from "./provider-model-id-normalize.js";

describe("OpenAI message-end cached model ids", () => {
  it.each(["gpt-6", "gpt-6-sol", "gpt-6-sol-pro", "gpt-5.6-luna", "gpt-6:nitro", "GPT-6"])(
    "matches %s",
    (id) => {
      expect(isOpenAIMessageEndCachedModelId(id)).toBe(true);
    },
  );

  it.each(["gpt-5", "gpt-5.5", "gpt-5.5-pro", "gpt-5:nitro", "gpt-60x", "openai/gpt-6", "o3"])(
    "does not match %s",
    (id) => {
      expect(isOpenAIMessageEndCachedModelId(id)).toBe(false);
    },
  );
});

describe("provider model id normalization", () => {
  it("routes bare Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("gemini-3-pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("does not rewrite already-current Gemini replacement ids", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("maps deprecated flash-lite-preview to GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite-preview")).toBe(
      "gemini-3.1-flash-lite",
    );
    expect(normalizeGooglePreviewModelId("google/gemini-3.1-flash-lite-preview")).toBe(
      "google/gemini-3.1-flash-lite",
    );
  });

  it("does not rewrite stable GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite");
  });
});
