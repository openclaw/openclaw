/** Tests agent compaction settings and small-context auto-compaction guards. */
import { describe, expect, it, vi } from "vitest";
import { shouldCompact } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "./agent-settings.js";
import { SettingsManager } from "./sessions/settings-manager.js";

describe("applyAgentCompactionSettingsFromConfig", () => {
  it.each([false])(
    "applies and preserves compaction.enabled=%s across a settings reload",
    async (configuredEnabled) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: !configuredEnabled, reserveTokens: 20_000 },
      });
      const setCompactionEnabled = vi.spyOn(settingsManager, "setCompactionEnabled");
      const cfg = {
        agents: { defaults: { compaction: { enabled: configuredEnabled } } },
      };

      applyAgentCompactionSettingsFromConfig({ settingsManager, cfg });
      await settingsManager.reload();
      expect(settingsManager.getCompactionEnabled()).toBe(configuredEnabled);
      applyAgentCompactionSettingsFromConfig({ settingsManager, cfg });

      expect(setCompactionEnabled).toHaveBeenCalledExactlyOnceWith(configuredEnabled);
      expect(settingsManager.getCompactionEnabled()).toBe(configuredEnabled);
    },
  );

  const forcedDisableCases: Array<
    [string, Omit<Parameters<typeof applyAgentAutoCompactionGuard>[0], "settingsManager">]
  > = [
    [
      "context-engine ownership",
      {
        contextEngineInfo: {
          id: "third-party",
          name: "Third-party Context Engine",
          version: "0.1.0",
          ownsCompaction: true,
        },
      },
    ],
    ["compaction-forbidden operation", { compactionForbidden: true }],
  ];

  it.each(forcedDisableCases)(
    "keeps the %s safety guard authoritative over explicit enabled=true",
    (_label, guardParams) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 50_000 },
      });

      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        cfg: { agents: { defaults: { compaction: { enabled: true } } } },
      });
      applyAgentAutoCompactionGuard({ settingsManager, ...guardParams });
      expect(settingsManager.getCompactionEnabled()).toBe(false);
      expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
    },
  );

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 20_000 } });
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokens: 15_000,
            },
          },
        },
      },
    });

    expect(settingsManager.getCompactionKeepRecentTokens()).toBe(15_000);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("keeps a fresh 32K tool turn out of compaction until the conversation grows", () => {
    const settingsManager = SettingsManager.inMemory();
    applyAgentCompactionSettingsFromConfig({ settingsManager, contextTokenBudget: 32_768 });
    const settings = settingsManager.getCompactionSettings();

    // Live local-model proof used 12,824 prompt tokens on its first successful tool turn.
    expect(shouldCompact(12_824, 32_768, settings)).toBe(false);
    expect(shouldCompact(24_576, 32_768, settings)).toBe(false);
    expect(shouldCompact(24_577, 32_768, settings)).toBe(true);
  });

  it("does not cap floor when context window is large enough", () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 16_384 } });
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    // The large-window default keeps its existing 20,000-token reserve.
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 200_000,
    });

    expect(settingsManager.getCompactionReserveTokens()).toBe(
      DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });
});

describe("resolveEffectiveCompactionMode", () => {
  it("defaults to default compaction mode", () => {
    expect(resolveEffectiveCompactionMode()).toBe("default");
    expect(resolveEffectiveCompactionMode({ agents: { defaults: { compaction: {} } } })).toBe(
      "default",
    );
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "default" } } },
      }),
    ).toBe("default");
  });

  it("returns safeguard for explicit safeguard mode", () => {
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "safeguard" } } },
      }),
    ).toBe("safeguard");
  });

  it("returns safeguard when a compaction provider is configured", () => {
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { provider: "deepseek" } } },
      }),
    ).toBe("safeguard");
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "default", provider: "deepseek" } } },
      }),
    ).toBe("safeguard");
  });
});

describe("isSilentOverflowProneModel", () => {
  it("flags a direct api.z.ai baseUrl via endpointClass", () => {
    expect(
      isSilentOverflowProneModel({
        provider: "openai",
        modelId: "glm-5.1",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
    ).toBe(true);
  });

  // openclaw#75799 reporter's setup: an OpenAI-compatible in-house gateway
  // exposing Zhipu's GLM family directly (model id `glm-5.1`, no `z-ai/`
  // qualifier, custom baseUrl that is not api.z.ai). Catch the bare GLM
  // family name so direct gateway deployments hit the guard regardless of
  // what `provider` field the user picked — gateways relabel the upstream
  // identity, so `provider` here can be anything from `openai` to a custom
  // string. False positives only disable OpenClaw runtime's secondary compaction path;
  // OpenClaw's preemptive compaction continues to handle real overflow.
  it("flags bare glm- model ids without a namespace prefix, regardless of provider", () => {
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-4.7" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openai", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openrouter", modelId: "glm-5.1" })).toBe(true);
  });

  it("treats missing fields as not silent-overflow-prone", () => {
    expect(isSilentOverflowProneModel({})).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: undefined, modelId: undefined, baseUrl: null }),
    ).toBe(false);
  });
});
