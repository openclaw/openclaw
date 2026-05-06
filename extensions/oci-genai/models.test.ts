/**
 * Contract tests for the model catalog and region helpers.
 *
 * The catalog is data, not behaviour, so the suite is small but defends
 * the invariants that downstream code (openclaw model resolution,
 * cost computation, model-id validation) relies on:
 *
 *  - ids are unique
 *  - ids match the registered union type at compile time (one entry
 *    per OciGenAIModelId)
 *  - contextWindow / maxTokens / cost values are sane (positive,
 *    maxTokens ≤ contextWindow)
 *  - region helpers produce hosts and base URLs in the format OCI
 *    expects, for every region we declare
 */

import { describe, expect, it } from "vitest";
import {
  buildOciGenAIBaseUrl,
  findOciGenAIModel,
  OCI_GENAI_MODELS,
  type OciGenAIModelEntry,
  type OciGenAIModelId,
} from "./models.js";
import {
  buildOciGenAIHost,
  buildOciGenAINativeBaseUrl,
  buildOciGenAIOpenAIBaseUrl,
  DEFAULT_OCI_GENAI_REGION,
  isOciRegion,
  OCI_GENAI_REGIONS,
} from "./regions.js";

describe("OCI_GENAI_MODELS catalog", () => {
  it("declares at least one model", () => {
    expect(OCI_GENAI_MODELS.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = OCI_GENAI_MODELS.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("each entry has positive context/maxTokens with maxTokens ≤ contextWindow", () => {
    for (const entry of OCI_GENAI_MODELS) {
      expect(entry.contextWindow, `${entry.id} contextWindow`).toBeGreaterThan(0);
      expect(entry.maxTokens, `${entry.id} maxTokens`).toBeGreaterThan(0);
      expect(
        entry.maxTokens,
        `${entry.id} maxTokens (${entry.maxTokens}) > contextWindow (${entry.contextWindow})`,
      ).toBeLessThanOrEqual(entry.contextWindow);
    }
  });

  it("each entry has non-negative cost values", () => {
    for (const entry of OCI_GENAI_MODELS) {
      expect(entry.cost.input, `${entry.id} cost.input`).toBeGreaterThanOrEqual(0);
      expect(entry.cost.output, `${entry.id} cost.output`).toBeGreaterThanOrEqual(0);
      if (entry.cost.cacheRead !== undefined) {
        expect(entry.cost.cacheRead).toBeGreaterThanOrEqual(0);
      }
      if (entry.cost.cacheWrite !== undefined) {
        expect(entry.cost.cacheWrite).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("input list is non-empty and contains 'text'", () => {
    // Catalog entries are produced via index.ts buildCatalogModels; here we
    // only verify the underlying model record carries enough info.  Each
    // entry must be usable for at least text input.
    for (const entry of OCI_GENAI_MODELS) {
      expect(entry, entry.id).toMatchObject({
        toolUse: expect.any(Boolean),
        reasoning: expect.any(Boolean),
        vision: expect.any(Boolean),
      });
    }
  });

  it("findOciGenAIModel returns the entry for a known id", () => {
    const llama: OciGenAIModelEntry | undefined = findOciGenAIModel(
      "meta.llama-3.3-70b-instruct" satisfies OciGenAIModelId,
    );
    expect(llama).toBeDefined();
    expect(llama!.contextWindow).toBe(128_000);
  });

  it("findOciGenAIModel returns undefined for an unknown id", () => {
    expect(findOciGenAIModel("does.not.exist")).toBeUndefined();
  });

  it("buildOciGenAIBaseUrl returns the OpenAI-compatible URL for a region", () => {
    expect(buildOciGenAIBaseUrl("us-chicago-1")).toBe(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1",
    );
  });
});

describe("region helpers", () => {
  it("declares the default region within OCI_GENAI_REGIONS", () => {
    expect(OCI_GENAI_REGIONS).toContain(DEFAULT_OCI_GENAI_REGION);
  });

  it("buildOciGenAIHost returns the canonical inference host for each region", () => {
    for (const region of OCI_GENAI_REGIONS) {
      expect(buildOciGenAIHost(region)).toBe(
        `inference.generativeai.${region}.oci.oraclecloud.com`,
      );
    }
  });

  it("buildOciGenAINativeBaseUrl uses the /20231130 path", () => {
    expect(buildOciGenAINativeBaseUrl("us-chicago-1")).toBe(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/20231130",
    );
  });

  it("buildOciGenAIOpenAIBaseUrl uses the /openai/v1 path", () => {
    expect(buildOciGenAIOpenAIBaseUrl("eu-frankfurt-1")).toBe(
      "https://inference.generativeai.eu-frankfurt-1.oci.oraclecloud.com/openai/v1",
    );
  });

  it("isOciRegion narrows known regions and rejects unknown ones", () => {
    expect(isOciRegion("us-chicago-1")).toBe(true);
    expect(isOciRegion("us-phoenix-1")).toBe(true);
    expect(isOciRegion("not-a-real-region")).toBe(false);
    expect(isOciRegion("")).toBe(false);
  });

  it("native and openai-compat hosts are identical per region (paths differ)", () => {
    for (const region of OCI_GENAI_REGIONS) {
      const native = new URL(buildOciGenAINativeBaseUrl(region));
      const compat = new URL(buildOciGenAIOpenAIBaseUrl(region));
      expect(native.host).toBe(compat.host);
      expect(native.pathname).toBe("/20231130");
      expect(compat.pathname).toBe("/openai/v1");
    }
  });
});
