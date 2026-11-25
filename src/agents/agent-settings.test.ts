import { describe, expect, it, vi } from "vitest";
import { shouldCompact } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentCompactionConfig } from "../config/types.agent-defaults.js";
import {
  applyAgentAutoCompactionGuard as applyGuard,
  applyAgentCompactionSettingsFromConfig as applySettings,
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR as reserveFloor,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "./agent-settings.js";
import { SettingsManager } from "./sessions/settings-manager.js";

function compactionConfig(compaction: AgentCompactionConfig) {
  return { agents: { defaults: { compaction } } };
}
const settingsWithReserve = (reserveTokens: number, enabled?: boolean) =>
  SettingsManager.inMemory({
    compaction: { reserveTokens, ...(enabled === undefined ? {} : { enabled }) },
  });
function applyReserve(
  reserveTokens?: number,
  contextTokenBudget?: number,
  compaction?: AgentCompactionConfig,
) {
  const settingsManager =
    reserveTokens === undefined ? SettingsManager.inMemory() : settingsWithReserve(reserveTokens);
  const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");
  applySettings({
    settingsManager,
    contextTokenBudget,
    cfg: compaction && compactionConfig(compaction),
  });
  return { settingsManager, applyOverrides };
}

describe("applyAgentCompactionSettingsFromConfig", () => {
  it.each([false, true])("applies compaction.enabled=%s idempotently", (configuredEnabled) => {
    const settingsManager = settingsWithReserve(20_000, !configuredEnabled);
    const setCompactionEnabled = vi.spyOn(settingsManager, "setCompactionEnabled");
    const cfg = compactionConfig({ enabled: configuredEnabled });
    applySettings({ settingsManager, cfg });
    expect(settingsManager.getCompactionEnabled()).toBe(configuredEnabled);
    applySettings({ settingsManager, cfg });

    expect(setCompactionEnabled).toHaveBeenCalledExactlyOnceWith(configuredEnabled);
    expect(settingsManager.getCompactionEnabled()).toBe(configuredEnabled);
  });

  const forcedDisableCases: Array<
    [string, Omit<Parameters<typeof applyGuard>[0], "settingsManager">]
  > = [
    ["safeguard mode", { compactionMode: "safeguard" }],
    [
      "context-engine ownership",
      {
        contextEngineInfo: {
          id: "third-party",
          name: "Third-party",
          version: "0.1.0",
          ownsCompaction: true,
        },
      },
    ],
    ["silent-overflow protection", { silentOverflowProneProvider: true }],
    ["compaction-forbidden operation", { compactionForbidden: true }],
  ];

  it.each(forcedDisableCases)(
    "keeps the %s safety guard authoritative over explicit enabled=true",
    (_label, guardParams) => {
      const settingsManager = settingsWithReserve(20_000, false);

      applySettings({ settingsManager, cfg: compactionConfig({ enabled: true }) });
      applyGuard({ settingsManager, ...guardParams });
      expect(settingsManager.getCompactionEnabled()).toBe(false);
    },
  );

  it("preserves the embedded project setting when compaction.enabled is omitted", () => {
    const settingsManager = settingsWithReserve(20_000, false);
    const setCompactionEnabled = vi.spyOn(settingsManager, "setCompactionEnabled");

    applySettings({ settingsManager, cfg: compactionConfig({}) });

    expect(settingsManager.getCompactionEnabled()).toBe(false);
    expect(setCompactionEnabled).not.toHaveBeenCalled();
  });

  it("can restore reserveTokens after a simulated resource loader reload drops them below floor", () => {
    const { settingsManager, applyOverrides } = applyReserve(16_384, 100_000);
    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);
    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { reserveTokens: reserveFloor } });

    settingsManager.applyOverrides({ compaction: { reserveTokens: 16_384 } });
    applySettings({ settingsManager, contextTokenBudget: 100_000 });
    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const { settingsManager, applyOverrides } = applyReserve(32_000, undefined, {
      mode: "default",
    });
    expect(settingsManager.getCompactionReserveTokens()).toBe(32_000);
    expect(applyOverrides).not.toHaveBeenCalled();
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const { settingsManager, applyOverrides } = applyReserve(20_000, undefined, {
      keepRecentTokens: 15_000,
    });
    expect(settingsManager.getCompactionKeepRecentTokens()).toBe(15_000);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const { settingsManager, applyOverrides } = applyReserve(25_000, undefined, {
      mode: "safeguard",
    });
    expect(settingsManager.getCompactionKeepRecentTokens()).toBe(20_000);
    expect(applyOverrides).not.toHaveBeenCalled();
  });

  it("caps the effective reserve so small-context models do not compact at token one", () => {
    const { settingsManager, applyOverrides } = applyReserve(undefined, 16_384);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 4_096 },
    });
    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 4_096,
      keepRecentTokens: 20_000,
    });
    expect(shouldCompact(1, 16_384, settingsManager.getCompactionSettings())).toBe(false);
  });

  it.each<[number | undefined, number | undefined, number]>([
    [2_048, 16_384, 4_096],
    [undefined, undefined, reserveFloor],
    [16_384, 200_000, reserveFloor],
  ])("raises reserve %s to %s-context floor %s", (initial, budget, expected) => {
    const { settingsManager, applyOverrides } = applyReserve(initial, budget);
    expect(settingsManager.getCompactionReserveTokens()).toBe(expected);
    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { reserveTokens: expected } });
  });

  it("keeps a fresh 32K tool turn out of compaction until the conversation grows", () => {
    const settingsManager = SettingsManager.inMemory();
    applySettings({ settingsManager, contextTokenBudget: 32_768 });
    const settings = settingsManager.getCompactionSettings();

    // Live local-model proof used 12,824 prompt tokens on its first successful tool turn.
    expect(shouldCompact(12_824, 32_768, settings)).toBe(false);
    expect(shouldCompact(24_576, 32_768, settings)).toBe(false);
    expect(shouldCompact(24_577, 32_768, settings)).toBe(true);
  });
});

describe("resolveEffectiveCompactionMode", () => {
  it.each<[AgentCompactionConfig | undefined, "default" | "safeguard"]>([
    [undefined, "default"],
    [{}, "default"],
    [{ mode: "default" }, "default"],
    [{ mode: "safeguard" }, "safeguard"],
    [{ provider: "deepseek" }, "safeguard"],
    [{ mode: "default", provider: "deepseek" }, "safeguard"],
  ])("resolves %j to %s", (compaction, expected) => {
    expect(resolveEffectiveCompactionMode(compaction && compactionConfig(compaction))).toBe(
      expected,
    );
  });
});

// #75799: bare GLM ids cover relabeled gateways, but other hosts' namespaced ids stay exempt.
it.each([
  ["openrouter", "z-ai/glm-5.1", true],
  ["openrouter", "openrouter/z-ai/glm-5", true],
  ["z.ai", "glm-5.1", true],
  ["z-ai", "glm-5.1", true],
  ["openai", "glm-5.1", true, "https://api.z.ai/api/coding/paas/v4"],
  ["custom", "glm-5.1", true],
  ["custom", "glm-4.7", true],
  ["openai", "glm-5.1", true],
  ["openrouter", "glm-5.1", true],
  ["ollama", "ollama/glm-5.1:cloud", false],
  ["opencode-go", "opencode-go/glm-5.1", false],
  ["anthropic", "claude-sonnet-4.6", false],
  ["openai", "gpt-5.5", false],
  ["openrouter", "anthropic/claude-sonnet-4.6", false],
  ["google", "gemini-2.5-pro", false],
  [undefined, undefined, false],
  [undefined, undefined, false, null],
] satisfies Array<[string | undefined, string | undefined, boolean, (string | null)?]>)(
  "classifies silent overflow for %s/%s as %s (endpoint %s)",
  (provider, modelId, expected, baseUrl?: string | null) => {
    expect(isSilentOverflowProneModel({ provider, modelId, baseUrl })).toBe(expected);
  },
);

describe("applyAgentAutoCompactionGuard", () => {
  it("preserves configured reserve tokens when disabling embedded auto-compaction", () => {
    const settingsManager = settingsWithReserve(50_000, true);
    applyGuard({ settingsManager, compactionMode: "safeguard" });

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 20_000,
    });
  });

  it("leaves embedded auto-compaction alone for non-z.ai providers without engine ownership", () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 4_000 },
    });
    const setCompactionEnabled = vi.spyOn(settingsManager, "setCompactionEnabled");

    applyGuard({
      settingsManager,
      contextEngineInfo: {
        id: "legacy",
        name: "Legacy Context Engine",
        version: "1.0.0",
      },
      silentOverflowProneProvider: false,
    });

    expect(settingsManager.getCompactionEnabled()).toBe(true);
    expect(setCompactionEnabled).not.toHaveBeenCalled();
  });
});
