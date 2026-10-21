/** Tests agent compaction settings and small-context auto-compaction guards. */
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
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 20_000 },
    });
    const setCompactionEnabled = vi.spyOn(settingsManager, "setCompactionEnabled");

    applySettings({
      settingsManager,
      cfg: { agents: { defaults: { compaction: {} } } },
    });

    expect(settingsManager.getCompactionEnabled()).toBe(false);
    expect(setCompactionEnabled).not.toHaveBeenCalled();
  });

  it("bumps reserveTokens when below floor", () => {
    const settingsManager = SettingsManager.inMemory();
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({ settingsManager });

    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: reserveFloor },
    });
  });

  it("can restore reserveTokens after a simulated resource loader reload drops them below floor", () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 16_384 },
    });

    applySettings({
      settingsManager,
      contextTokenBudget: 100_000,
    });
    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);

    settingsManager.applyOverrides({ compaction: { reserveTokens: 16_384 } });
    applySettings({
      settingsManager,
      contextTokenBudget: 100_000,
    });
    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 32_000 } });
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(settingsManager.getCompactionReserveTokens()).toBe(32_000);
    expect(applyOverrides).not.toHaveBeenCalled();
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = settingsWithReserve(20_000);
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({ settingsManager, cfg: compactionConfig({ keepRecentTokens: 15_000 }) });

    expect(settingsManager.getCompactionKeepRecentTokens()).toBe(15_000);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 25_000 } });
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard" } } } },
    });

    expect(settingsManager.getCompactionKeepRecentTokens()).toBe(20_000);
    expect(applyOverrides).not.toHaveBeenCalled();
  });

  it("caps the effective reserve so small-context models do not compact at token one", () => {
    // Embedded runner default reserveTokens is 16 384. With a 16 384 context window
    // both the default reserve and floor exceed one quarter of the model window.
    const settingsManager = SettingsManager.inMemory();
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({
      settingsManager,
      contextTokenBudget: 16_384,
    });

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

  it("applies capped floor when current reserve is below it on small-context models", () => {
    // A smaller project reserve is raised to the context-scaled floor.
    const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 2_048 } });
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    expect(settingsManager.getCompactionReserveTokens()).toBe(4_096);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 4_096 },
    });
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

  it("does not cap floor when context window is large enough", () => {
    const settingsManager = settingsWithReserve(16_384);
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applySettings({ settingsManager, contextTokenBudget: 200_000 });
    expect(settingsManager.getCompactionReserveTokens()).toBe(reserveFloor);
    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { reserveTokens: reserveFloor } });
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

describe("isSilentOverflowProneModel", () => {
  // Reporter's repro shape: openrouter routing to z-ai/glm. Both the bare
  // `z-ai/...` form and the `openrouter/z-ai/...` qualified form must hit.
  it("flags z-ai-prefixed model ids regardless of qualifier", () => {
    expect(isSilentOverflowProneModel({ provider: "openrouter", modelId: "z-ai/glm-5.1" })).toBe(
      true,
    );
    expect(
      isSilentOverflowProneModel({ provider: "openrouter", modelId: "openrouter/z-ai/glm-5" }),
    ).toBe(true);
  });

  it("flags a config-set z.ai provider regardless of model id", () => {
    expect(isSilentOverflowProneModel({ provider: "z.ai", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "z-ai", modelId: "glm-5.1" })).toBe(true);
  });

  it("flags a direct api.z.ai baseUrl via endpointClass", () => {
    expect(
      isSilentOverflowProneModel({
        provider: "openai",
        modelId: "glm-5.1",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
    ).toBe(true);
  });

  // #75799: gateways relabel bare GLM models; the secondary compaction guard must survive.
  it("flags bare glm- model ids without a namespace prefix, regardless of provider", () => {
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-4.7" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openai", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openrouter", modelId: "glm-5.1" })).toBe(true);
  });

  // Detection is intentionally narrow to z.ai-style accounting. Namespaced GLM
  // ids that route through providers with their own overflow accounting must
  // NOT be flagged — those hosts may not exhibit the z.ai silent-overflow
  // shape, and disabling embedded auto-compaction for them would over-broaden the
  // kill surface beyond the reproducible repro.
  it("does not flag namespaced GLM ids routed through non-z.ai hosts", () => {
    expect(
      isSilentOverflowProneModel({ provider: "ollama", modelId: "ollama/glm-5.1:cloud" }),
    ).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: "opencode-go", modelId: "opencode-go/glm-5.1" }),
    ).toBe(false);
  });

  // shared model runtime's overflow.ts only documents z.ai as the silent-overflow style. We
  // intentionally do NOT extend the guard to anthropic/openai/google/openrouter-
  // anthropic routes — adding them without a reproducible repro would broaden
  // the kill surface and regress baseline behavior for those providers.
  it("does not flag anthropic, openai, google or other routes", () => {
    expect(
      isSilentOverflowProneModel({ provider: "anthropic", modelId: "claude-sonnet-4.6" }),
    ).toBe(false);
    expect(isSilentOverflowProneModel({ provider: "openai", modelId: "gpt-5.5" })).toBe(false);
    expect(
      isSilentOverflowProneModel({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
      }),
    ).toBe(false);
    expect(isSilentOverflowProneModel({ provider: "google", modelId: "gemini-2.5-pro" })).toBe(
      false,
    );
  });

  it("treats missing fields as not silent-overflow-prone", () => {
    expect(isSilentOverflowProneModel({})).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: undefined, modelId: undefined, baseUrl: null }),
    ).toBe(false);
  });
});

describe("applyAgentAutoCompactionGuard", () => {
  it("preserves configured reserve tokens when disabling embedded auto-compaction", () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 50_000 },
    });

    applyGuard({
      settingsManager,
      compactionMode: "safeguard",
    });

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 20_000,
    });
  });

  // Default-mode runs against ordinary providers must keep OpenClaw runtime's auto-compaction
  // enabled. Disabling it across the board would silently remove OpenClaw runtime's
  // overflow-recovery path inside Session.prompt() for users who are not
  // affected by z.ai's silent-overflow accounting.
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
