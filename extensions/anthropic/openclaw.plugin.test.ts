import { expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const selectableContextWindowMetadata = {
  contextWindows: [
    { id: "200k", label: "200K", contextWindow: 200_000 },
    { id: "1m", label: "1M", contextWindow: 1_000_000 },
  ],
  contextWindowDefault: "1m",
};

it("keeps Haiku opt-in while preferring Code Mode for the other API models", () => {
  const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) {
    expect(model.compat?.codeMode, model.id).toBe(
      model.id.startsWith("claude-haiku-") ? "capable" : "preferred",
    );
  }
});

it.each([
  ["claude-opus-5-5", "Claude Opus 5.5", [4, 20, 0.2, 5], true],
  ["claude-opus-5", "Claude Opus 5", [5, 25, 0.5, 6.25], false],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", [2, 10, 0.1, 2.5], true],
  ["claude-sonnet-5", "Claude Sonnet 5", [2, 10, 0.2, 2.5], false],
  ["claude-fable-5-1", "Claude Fable 5.1", [10, 50, 0.25, 12.5], true],
  ["claude-fable-5", "Claude Fable 5", [10, 50, 1, 12.5], true],
] as const)(
  "publishes %s API contracts",
  (id, name, [input, output, cacheRead, cacheWrite], remapsMinimal) => {
    expect(
      manifest.modelCatalog.providers.anthropic.models.find((model) => model.id === id),
    ).toEqual({
      id,
      name,
      reasoning: true,
      input: ["text", "image"],
      mediaInput: { image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" } },
      contextWindow: 1_000_000,
      ...selectableContextWindowMetadata,
      maxTokens: 128_000,
      cost: { input, output, cacheRead, cacheWrite },
      thinkingLevelMap: {
        ...(remapsMinimal ? { minimal: "low" } : {}),
        xhigh: "xhigh",
        max: "max",
      },
      compat: { codeMode: "preferred" },
    });
  },
);

it("preserves deprecated API metadata without seeding native membership", () => {
  const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
  expect(models.find((model) => model.id === "claude-opus-4-8")).toMatchObject({
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    status: "deprecated",
    replacedBy: "claude-opus-5",
  });
  expect(manifest.modelCatalog.providers["claude-cli"].models).toEqual([]);
  expect(manifest.modelCatalog.discovery["claude-cli"]).toBe("refreshable");
});

it("keeps only the dateless Claude Haiku 4.5 identifier in the static catalog", () => {
  expect(manifest.modelCatalog?.discovery?.anthropic).toBe("refreshable");

  const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
  expect(models.find((model) => model.id === "claude-haiku-4-5")).toEqual({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    mediaInput: {
      image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
    },
    contextWindow: 200000,
    maxTokens: 64000,
    compat: { codeMode: "capable" },
  });
  expect(models.find((model) => model.id === "claude-haiku-4-5-20251001")).toBeUndefined();
});
