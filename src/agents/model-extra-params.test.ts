import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasAuthoredProviderRequestParams } from "./model-extra-params.js";

const modelKey = "openai/fixture-model";
const options = { nativeContextManagement: true };
const sources = ["default", "model", "agent-model", "agent"] as const;
function configuration(
  source: (typeof sources)[number],
  params: Record<string, unknown>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        params: source === "default" ? params : undefined,
        models: { [modelKey]: { params: source === "model" ? params : undefined } },
      },
      entries: {
        fixture: {
          params: source === "agent" ? params : undefined,
          models: { [modelKey]: { params: source === "agent-model" ? params : undefined } },
        },
      },
    },
  };
}
function classify(config: OpenClawConfig, native = true) {
  return hasAuthoredProviderRequestParams(
    { config, agentId: "fixture", provider: "openai", modelId: "fixture-model" },
    native ? options : undefined,
  );
}
describe("native context management tuning", () => {
  it.each(sources)(
    "tolerates only compaction in %s parameters without changing shared config",
    (source) => {
      for (const responsesServerCompaction of [true, false]) {
        for (const responsesCompactThreshold of [700000, 700000.9, "700000"]) {
          const config = configuration(source, {
            responsesServerCompaction,
            responsesCompactThreshold,
          });
          const before = structuredClone(config);
          expect(classify(config)).toBe(false);
          expect(classify(config, false)).toBe(true);
          expect(config).toEqual(before);
        }
      }
      for (const params of [
        { responsesServerCompaction: "false" },
        { responsesCompactThreshold: -1 },
        { responsesCompactThreshold: Infinity },
        { responsesCompactThreshold: "invalid" },
        { responsesServerCompaction: true, store: false },
        { responsesCompactThreshold: 700000, temperature: 0.5 },
        { responsesServerCompaction: true, arbitraryBody: { policy: "required" } },
      ]) {
        expect(classify(configuration(source, params)), JSON.stringify(params)).toBe(true);
      }
    },
  );
  it("does not broaden default or agent-wide typed control exemptions", () => {
    for (const source of sources) {
      expect(classify(configuration(source, { fastMode: true }))).toBe(
        source === "default" || source === "agent",
      );
    }
  });
});
