import { expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type Config = Parameters<typeof normalizeCompatibilityConfig>[0]["cfg"];
type PluginEntry = NonNullable<NonNullable<Config["plugins"]>["entries"]>[string];
const policy = (allow = true) => ({ allowModelOverride: allow, allowAuthProfileOverride: allow });
const allowed = ["openai/gpt-5.6-sol"];
const otherAllowed = ["anthropic/claude-haiku-4-5"];
const restricted = { ...policy(false), allowedModels: otherAllowed };
const path = "plugins.entries.llm-task";

function migrate(entry: PluginEntry) {
  const result = normalizeCompatibilityConfig({
    cfg: { plugins: { entries: { "llm-task": entry } } },
  });
  return { entry: result.config.plugins?.entries?.["llm-task"], changes: result.changes };
}

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
  const result = migrate({ llm: restricted, config: { allowedModels: allowed } });
  expect(result.entry).toEqual({
    llm: { ...restricted, allowedCompletionModels: allowed },
    config: {},
  });
  expect(result.changes).toHaveLength(1);
});

it("keeps an explicit completion policy authoritative over the legacy key", () => {
  const result = migrate({
    llm: { ...policy(), allowedCompletionModels: otherAllowed },
    config: { allowedModels: allowed },
  });
  expect(result.entry?.llm?.allowedCompletionModels).toEqual(otherAllowed);
  expect(result.entry?.config).toEqual({});
  expect(result.changes).toHaveLength(1);
});

it("preserves the unrestricted meaning of an empty legacy allowlist", () => {
  const result = migrate({ enabled: true, config: { allowedModels: [] } });
  expect(result.entry?.llm).toEqual(policy());
  expect(result.entry?.config).toEqual({});
  expect(result.changes).toHaveLength(2);
});

it.each([
  ["literal refs only", ["*", ` ${allowed[0]} `, "OpenAI/gpt-5.5", ...allowed], allowed],
  ["non-array fails closed", "openai/gpt-5.6", []],
  ["non-string entries fail closed", [123, null], []],
])("migrates allowlists: %s", (_name, allowedModels, expected) => {
  const { entry } = migrate({ config: { allowedModels } });
  expect(entry?.llm?.allowedCompletionModels).toEqual(expected);
});

it("is idempotent after migration", () => {
  const entry = { llm: policy(), config: {} };
  const cfg = { plugins: { entries: { "llm-task": entry } } };
  const result = normalizeCompatibilityConfig({ cfg });
  expect(result.config).toBe(cfg);
  expect(result.changes).toEqual([]);
});
