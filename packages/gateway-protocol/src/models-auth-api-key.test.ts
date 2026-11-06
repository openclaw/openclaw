import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ModelsAuthSetApiKeyParams,
  type ModelsAuthSetApiKeyResult,
  validateModelsAuthSetApiKeyParams,
  validateModelsAuthSetApiKeyResult,
} from "./index.js";
import { ProtocolSchemas } from "./schema.js";

describe("public models.authSetApiKey contract", () => {
  it("accepts existing wire fields and ignores request extensions", () => {
    const request = { provider: " Fixture ", apiKey: " synthetic-key " };
    expectTypeOf(request).toExtend<ModelsAuthSetApiKeyParams>();
    for (const agentId of [undefined, "", "writer"]) {
      expect(validateModelsAuthSetApiKeyParams({ ...request, agentId, futureField: true })).toBe(
        true,
      );
    }
    expect(ProtocolSchemas.ModelsAuthSetApiKeyParams).toBeDefined();
    expect(ProtocolSchemas.ModelsAuthSetApiKeyResult).toBeDefined();
  });

  it.each([
    {},
    { provider: "fixture" },
    { provider: 1, apiKey: "key" },
    { provider: " ", apiKey: "key" },
    { provider: "fixture", apiKey: false },
    { provider: "fixture", apiKey: "\n\t" },
    { provider: "fixture", apiKey: "key", agentId: null },
  ])("rejects malformed request %j", (request) => {
    expect(validateModelsAuthSetApiKeyParams(request)).toBe(false);
  });

  it("describes saved keys with and without a refresh warning", () => {
    const result = { provider: "fixture", profileId: "fixture:manual" };
    expectTypeOf(result).toExtend<ModelsAuthSetApiKeyResult>();
    expect(validateModelsAuthSetApiKeyResult(result)).toBe(true);
    expect(validateModelsAuthSetApiKeyResult({ ...result, warning: "Restart to apply." })).toBe(
      true,
    );
    expect(validateModelsAuthSetApiKeyResult({ provider: "fixture" })).toBe(false);
    expect(validateModelsAuthSetApiKeyResult({ ...result, warning: false })).toBe(false);
  });
});
