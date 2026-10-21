import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type Config = Parameters<typeof normalizeCompatibilityConfig>[0]["cfg"];
type PluginEntry = NonNullable<NonNullable<Config["plugins"]>["entries"]>[string];
const policy = (allow = true) => ({ allowModelOverride: allow, allowAuthProfileOverride: allow });
const allowed = ["openai/gpt-5.6-sol"];
const otherAllowed = ["anthropic/claude-haiku-4-5"];
const path = "plugins.entries.llm-task";

function migrate(entry: PluginEntry) {
  const result = normalizeCompatibilityConfig({
    cfg: { plugins: { entries: { "llm-task": entry } } },
  });
  return { entry: result.config.plugins?.entries?.["llm-task"], changes: result.changes };
}

describe("llm-task doctor contract", () => {
  it("surfaces pre-policy entries and converges after migration", () => {
    const rule = legacyConfigRules.find((candidate) => candidate.path.join(".") === path);
    expect(rule?.match?.({ enabled: true })).toBe(true);
    expect(rule?.match?.({ llm: policy() })).toBe(false);
    expect(rule?.match?.({ llm: policy(false) })).toBe(false);
  });

  it("moves shipped model policy and grants the shipped override capabilities", () => {
    const result = migrate({
      enabled: true,
      config: { defaultModel: "gpt-5.6-sol", allowedModels: allowed },
    });

    expect(result.entry).toEqual({
      enabled: true,
      llm: { ...policy(), allowedCompletionModels: allowed },
      config: { defaultModel: "gpt-5.6-sol" },
    });
    expect(result.changes).toHaveLength(2);
  });

  it("keeps shipped override policy and migrates legacy completion policy separately", () => {
    const result = migrate({
      llm: { ...policy(false), allowedModels: otherAllowed },
      config: { allowedModels: allowed },
    });
    expect(result.entry).toEqual({
      llm: {
        ...policy(false),
        allowedModels: otherAllowed,
        allowedCompletionModels: allowed,
      },
      config: {},
    });
    expect(result.changes).toEqual([
      `Moved ${path}.config.allowedModels to ${path}.llm.allowedCompletionModels.`,
    ]);
  });

  it("keeps an explicit completion policy authoritative over the legacy key", () => {
    const result = migrate({
      llm: { ...policy(), allowedCompletionModels: otherAllowed },
      config: { allowedModels: allowed },
    });
    expect(result.entry?.llm?.allowedCompletionModels).toEqual(otherAllowed);
    expect(result.changes).toEqual([
      `Removed ${path}.config.allowedModels; existing ${path}.llm.allowedCompletionModels remains authoritative.`,
    ]);
  });

  it("preserves the unrestricted meaning of an empty legacy allowlist", () => {
    const result = migrate({ enabled: true, config: { allowedModels: [] } });
    expect(result.entry?.llm).toEqual(policy());
    expect(result.changes).toContain(
      `Removed empty ${path}.config.allowedModels; unrestricted model selection remains unchanged.`,
    );
  });

  it("does not give legacy literal wildcards or noncanonical refs new meaning", () => {
    const result = migrate({
      config: { allowedModels: ["*", " openai/gpt-5.4 ", "OpenAI/gpt-5.5", "openai/gpt-5.6"] },
    });
    expect(result.entry?.llm?.allowedCompletionModels).toEqual(["openai/gpt-5.6"]);
  });

  it.each([{ allowedModels: "openai/gpt-5.6" }, { allowedModels: [123, null] }])(
    "keeps malformed legacy allowlist $allowedModels fail closed",
    ({ allowedModels }) => {
      const result = migrate({ config: { allowedModels } });
      expect(result.entry?.llm?.allowedCompletionModels).toEqual([]);
    },
  );

  it("is idempotent after migration", () => {
    const cfg = {
      plugins: { entries: { "llm-task": { llm: policy(), config: {} } } },
    } as const;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
