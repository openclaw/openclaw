import { describe, expect, it } from "vitest";
import {
  buildEdenaiProvider,
  buildStaticEdenaiProvider,
  EDENAI_BASE_URL,
  getStaticEdenaiModelCatalog,
  normalizeEdenaiBaseUrl,
} from "./provider-catalog.js";

const EXPECTED_STATIC_MODEL_IDS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.5",
  "openai/gpt-4o-mini",
  "google/gemini-3.5-flash",
  "google/gemini-2.5-flash-lite",
  "mistral/mistral-large-latest",
];

describe("edenai provider catalog", () => {
  it("ships the curated 8-entry static catalog with hyphen Anthropic ids", () => {
    expect(getStaticEdenaiModelCatalog().map((m) => m.id)).toStrictEqual(EXPECTED_STATIC_MODEL_IDS);
  });

  it("builds an offline static provider catalog", () => {
    expect(buildStaticEdenaiProvider()).toStrictEqual({
      baseUrl: EDENAI_BASE_URL,
      api: "openai-completions",
      models: getStaticEdenaiModelCatalog(),
    });
  });

  it("falls back to the static catalog when discovery is skipped under vitest", async () => {
    const provider = await buildEdenaiProvider();

    expect(provider).toStrictEqual({
      baseUrl: EDENAI_BASE_URL,
      api: "openai-completions",
      models: getStaticEdenaiModelCatalog(),
    });
  });

  it("normalizes the canonical v3 base URL with or without trailing slash", () => {
    expect(normalizeEdenaiBaseUrl("https://api.edenai.run/v3")).toBe(EDENAI_BASE_URL);
    expect(normalizeEdenaiBaseUrl("https://api.edenai.run/v3/")).toBe(EDENAI_BASE_URL);
  });

  it("normalizes legacy v2 paths to the v3 endpoint", () => {
    expect(normalizeEdenaiBaseUrl("https://api.edenai.run/v2/llm")).toBe(EDENAI_BASE_URL);
    expect(normalizeEdenaiBaseUrl("https://api.edenai.run/v2")).toBe(EDENAI_BASE_URL);
  });

  it("returns undefined for unrelated base URLs", () => {
    expect(normalizeEdenaiBaseUrl("https://api.openai.com/v1")).toBeUndefined();
    expect(normalizeEdenaiBaseUrl("")).toBeUndefined();
    expect(normalizeEdenaiBaseUrl(undefined)).toBeUndefined();
  });
});
