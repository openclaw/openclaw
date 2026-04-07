import { describe, expect, it } from "vitest";
import { buildOpenrouterProvider } from "./provider-catalog.js";

describe("openrouter provider catalog", () => {
  it("builds the bundled OpenRouter provider defaults", () => {
    const provider = buildOpenrouterProvider();

    expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models?.length).toBeGreaterThan(0);
  });

  it("uses the canonical openrouter/auto id for the auto router (#62655)", () => {
    // Regression: prior to this fix, the auto entry was id="auto" while pi-ai's
    // built-in catalog uses id="openrouter/auto". `mergeCustomModels` dedupes by
    // raw `provider+id` string equality, so both entries survived into the
    // merged registry and the /models picker rendered two buttons ("OpenRouter
    // Auto" + "Auto Router") for the same upstream model. Using the canonical
    // prefixed id collapses the duplicate at the merge layer.
    const provider = buildOpenrouterProvider();
    const auto = provider.models?.find((m) => m.name === "OpenRouter Auto");

    expect(auto).toBeDefined();
    expect(auto?.id).toBe("openrouter/auto");
  });

  it("keeps every bundled model id namespaced under openrouter/", () => {
    // Defensive: any future model added to this catalog should follow the same
    // canonical-id convention. Without this, the same picker-duplicate bug
    // (#62655) reappears for the new model.
    const provider = buildOpenrouterProvider();
    const ids = provider.models?.map((m) => m.id) ?? [];

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith("openrouter/")).toBe(true);
    }
  });
});
