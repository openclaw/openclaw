// Model Catalog Core tests cover configured model refs behavior.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  extractProviderFromModelRef,
  pruneOrphanModelRefs,
} from "./configured-model-refs.js";

describe("configured model refs", () => {
  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            compaction: { memoryFlush: { model: "openai/gpt-5.5-mini" } },
          },
          list: [{ id: "custom", model: "xai/grok-4-fast" }],
        },
        hooks: {
          mappings: [{ model: "openai/gpt-5.5-nano" }],
        },
        messages: {
          tts: { summaryModel: "openai/gpt-5.5-mini" },
        },
        channels: {
          modelByChannel: {
            discord: {
              guild: "anthropic/claude-opus-4-8",
            },
          },
        },
      }),
    ).toEqual([
      { path: "agents.defaults.model.primary", value: "openai/gpt-5.5" },
      { path: "agents.defaults.model.fallbacks.0", value: "anthropic/claude-sonnet-4-6" },
      { path: "agents.defaults.compaction.memoryFlush.model", value: "openai/gpt-5.5-mini" },
      { path: "agents.list.0.model", value: "xai/grok-4-fast" },
      { path: "channels.modelByChannel.discord.guild", value: "anthropic/claude-opus-4-8" },
      { path: "hooks.mappings.0.model", value: "openai/gpt-5.5-nano" },
      { path: "messages.tts.summaryModel", value: "openai/gpt-5.5-mini" },
    ]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          channels: { modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } } },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5"]);
  });

  it("ignores array-shaped malformed records", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            models: ["openai/gpt-5.5"],
          },
        },
      }),
    ).toEqual([]);
  });

  it("extracts normalized providers from provider-prefixed refs", () => {
    expect(extractProviderFromModelRef(" OpenAI/gpt-5.5 ")).toBe("openai");
    expect(extractProviderFromModelRef("gpt-5.5")).toBeNull();
  });
});

describe("pruneOrphanModelRefs", () => {
  it("removes allowlist map entries for missing providers", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {},
              "ghostprovider/model-a": { alias: "ghost-a" },
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      },
      new Set(["openai", "anthropic"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
            "anthropic/claude-sonnet-4-6": {},
          },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.models.ghostprovider/model-a",
        value: "ghostprovider/model-a",
        reason: "missing-provider",
      },
    ]);
  });

  it("removes fallback array entries for missing providers", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["anthropic/claude-sonnet-4-6", "ghostprovider/foo", "openai/gpt-5.4"],
            },
          },
        },
      },
      new Set(["openai", "anthropic"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
          },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.model.fallbacks.1",
        value: "ghostprovider/foo",
        reason: "missing-provider",
      },
    ]);
  });

  it("rewrites primary refs using agents.defaults.model.primary as fallback", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
          list: [{ id: "agent-a", model: { primary: "ghostprovider/model-x" } }],
        },
      },
      new Set(["openai"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
        list: [{ id: "agent-a", model: { primary: "openai/gpt-5.5" } }],
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.list.0.model.primary",
        value: "ghostprovider/model-x",
        reason: "rewritten",
      },
    ]);
  });

  it("rewrites primary refs to first provider when defaults.model.primary is also orphan", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: { primary: "ghostprovider/model-y" },
          },
          list: [{ id: "agent-a", model: { primary: "ghostprovider/model-x" } }],
        },
      },
      new Set(["openai", "anthropic"]),
    );
    const config = result.config as any;
    expect(config.agents.defaults.model.primary).toMatch(/^(openai|anthropic)\/default$/);
    expect(config.agents.list[0].model.primary).toMatch(/^(openai|anthropic)\/default$/);
    expect(result.pruned).toHaveLength(2);
    expect(result.pruned.every((p) => p.reason === "rewritten")).toBe(true);
  });

  it("prunes from agents.list entries", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
          list: [
            { id: "agent-a", model: { fallbacks: ["ghostprovider/a", "openai/gpt-5.5"] } },
            { id: "agent-b", models: { "ghostprovider/b": {}, "openai/gpt-5.5": {} } },
          ],
        },
      },
      new Set(["openai"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
        list: [
          { id: "agent-a", model: { fallbacks: ["openai/gpt-5.5"] } },
          { id: "agent-b", models: { "openai/gpt-5.5": {} } },
        ],
      },
    });
    expect(result.pruned).toHaveLength(2);
  });

  it("ignores refs without provider prefix", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "gpt-5.5",
            models: { "gpt-5.5": {} },
          },
        },
      },
      new Set(["openai"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: "gpt-5.5",
          models: { "gpt-5.5": {} },
        },
      },
    });
    expect(result.pruned).toEqual([]);
  });

  it("preserves models when provider exists", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": {}, "anthropic/claude-sonnet-4-6": {} },
          },
        },
      },
      new Set(["openai", "anthropic"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {}, "anthropic/claude-sonnet-4-6": {} },
        },
      },
    });
    expect(result.pruned).toEqual([]);
  });

  it("handles compaction.model and subagents.model rewriting", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: { model: "ghostprovider/a", memoryFlush: { model: "ghostprovider/b" } },
            subagents: { model: { primary: "ghostprovider/c", fallbacks: ["ghostprovider/d"] } },
          },
        },
      },
      new Set(["openai"]),
    );
    const config = result.config as any;
    expect(config.agents.defaults.compaction.model).toBe("openai/gpt-5.5");
    expect(config.agents.defaults.compaction.memoryFlush.model).toBe("openai/gpt-5.5");
    expect(config.agents.defaults.subagents.model.primary).toBe("openai/gpt-5.5");
    expect(config.agents.defaults.subagents.model.fallbacks).toEqual([]);
    expect(result.pruned).toHaveLength(4);
  });

  it("prunes hooks.mappings and hooks.gmail model refs", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        hooks: {
          mappings: [{ model: "ghostprovider/hook-a" }],
          gmail: { model: "ghostprovider/hook-b" },
        },
      },
      new Set(["openai"]),
    );
    const config = result.config as any;
    expect(config.hooks.mappings[0].model).toBe("openai/gpt-5.5");
    expect(config.hooks.gmail.model).toBe("openai/gpt-5.5");
    expect(result.pruned).toHaveLength(2);
    expect(result.pruned.every((p) => p.reason === "rewritten")).toBe(true);
  });

  it("prunes messages.tts.summaryModel", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
        messages: { tts: { summaryModel: "ghostprovider/tts-model" } },
      },
      new Set(["anthropic"]),
    );
    const config = result.config as any;
    expect(config.messages.tts.summaryModel).toBe("anthropic/claude-sonnet-4-6");
    expect(result.pruned).toEqual([
      {
        path: "messages.tts.summaryModel",
        value: "ghostprovider/tts-model",
        reason: "rewritten",
      },
    ]);
  });

  it("prunes channels.modelByChannel and channels.discord.voice.model", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        channels: {
          modelByChannel: {
            discord: { guild: "ghostprovider/discord-a" },
            telegram: { chat: "openai/gpt-5.4" },
          },
          discord: { voice: { model: "ghostprovider/voice-model" } },
        },
      },
      new Set(["openai"]),
    );
    const config = result.config as any;
    expect(config.channels.modelByChannel.discord.guild).toBe("openai/gpt-5.5");
    expect(config.channels.modelByChannel.telegram.chat).toBe("openai/gpt-5.4");
    expect(config.channels.discord.voice.model).toBe("openai/gpt-5.5");
    expect(result.pruned).toHaveLength(2);
  });
});
