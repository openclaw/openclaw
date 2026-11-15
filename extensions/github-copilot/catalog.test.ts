import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("GitHub Copilot bundled model catalog", () => {
  it.each([
    ["claude-sonnet-5.5", "Claude Sonnet 5.5"],
    ["claude-opus-5.5", "Claude Opus 5.5"],
  ])("includes %s in the bundled provider catalog", (id, name) => {
    const { models } = buildManifestModelProviderConfig({
      providerId: "github-copilot",
      catalog: manifest.modelCatalog.providers["github-copilot"],
    });

    expect(models.find((model) => model.id === id)).toMatchObject({
      id,
      name,
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      compat: { codeMode: "capable" },
    });
  });
});
