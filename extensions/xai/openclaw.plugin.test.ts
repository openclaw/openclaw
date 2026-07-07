import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  modelCatalog?: {
    suppressions?: Array<{ provider?: string; model?: string }>;
  };
};

const XAI_MULTI_AGENT_MODELS = [
  "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent",
  "grok-4.20-multi-agent-latest",
  "grok-4.20-multi-agent-beta-latest",
  "grok-4.20-multi-agent-experimental-beta-0304",
  "grok-4.20-multi-agent-experimental-beta-latest",
  "grok-4.20-multi-agent-beta-0309",
] as const;

describe("xAI plugin manifest", () => {
  it("suppresses the unsupported multi-agent model aliases", () => {
    const suppressionRefs = new Set(
      (manifest.modelCatalog?.suppressions ?? []).map(
        (suppression) => `${suppression.provider}/${suppression.model}`,
      ),
    );

    for (const model of XAI_MULTI_AGENT_MODELS) {
      expect(suppressionRefs).toContain(`xai/${model}`);
    }
  });
});
