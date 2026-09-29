import { describe, expect, it } from "vitest";
import {
  type ConfiguredModelRef,
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  listModelRefsFromConfigValue,
} from "./configured-model-refs.js";

function ref(path: string, value: string, kind: ConfiguredModelRef["kind"] = "selector") {
  return { path, value, kind };
}

describe("configured model refs", () => {
  it("lists raw refs from one model selector without normalizing them", () => {
    expect(listModelRefsFromConfigValue("  openai/gpt-5.5  ")).toEqual(["  openai/gpt-5.5  "]);
    const selector = Object.freeze({
      primary: " primary/model ",
      fallbacks: Object.freeze(["", "fallback/model", 42, "fallback/model"]),
    });
    expect(listModelRefsFromConfigValue(selector)).toEqual([
      " primary/model ",
      "",
      "fallback/model",
      "fallback/model",
    ]);
    expect(collectConfiguredModelRefs({ agents: { defaults: { model: selector } } })).toEqual([
      ref("agents.defaults.model.primary", "primary/model"),
      ref("agents.defaults.model.fallbacks.1", "fallback/model"),
      ref("agents.defaults.model.fallbacks.3", "fallback/model"),
    ]);
    expect(listModelRefsFromConfigValue(["openai/gpt-5.5"])).toEqual([]);
    expect(listModelRefsFromConfigValue({ primary: 42, fallbacks: "openai/gpt-5.5" })).toEqual([]);
  });

  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            utilityModel: "google/gemini-3.1-flash-lite-preview",
            mediaModels: { image: "openai/gpt-image-2" },
            compaction: { memoryFlush: { model: "openai/gpt-5.5-mini" } },
          },
          entries: {
            custom: {
              model: "xai/grok-4-fast",
              utilityModel: "openai/gpt-5.5-nano",
            },
          },
        },
        hooks: {
          mappings: [{ model: "openai/gpt-5.5-nano" }],
        },
        tts: { summaryModel: "openai/gpt-5.5-mini" },
        channels: {
          modelByChannel: {
            discord: {
              guild: "anthropic/claude-opus-4-8",
            },
          },
        },
      }),
    ).toEqual([
      ref("agents.defaults.model.primary", "openai/gpt-5.5"),
      ref("agents.defaults.model.fallbacks.0", "anthropic/claude-sonnet-4-6"),
      ref("agents.defaults.utilityModel", "google/gemini-3.1-flash-lite-preview"),
      ref("agents.defaults.mediaModels.image", "openai/gpt-image-2", "literal"),
      ref("agents.defaults.compaction.memoryFlush.model", "openai/gpt-5.5-mini"),
      ref("agents.entries.custom.model", "xai/grok-4-fast"),
      ref("agents.entries.custom.utilityModel", "openai/gpt-5.5-nano"),
      ref("channels.modelByChannel.discord.guild", "anthropic/claude-opus-4-8"),
      ref("hooks.mappings.0.model", "openai/gpt-5.5-nano"),
      ref("tts.summaryModel", "openai/gpt-5.5-mini"),
    ]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          channels: {
            modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } },
            discord: { voice: { tts: { summaryModel: "discord-tts/model" } } },
          },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5", "discord-tts/model"]);
  });

  it("preserves legacy list indices when collecting agent model refs", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          list: [
            { id: "10", model: "openai/gpt-5.6" },
            { id: "2", utilityModel: "anthropic/claude-sonnet-4-6" },
          ],
        },
      }),
    ).toEqual([
      ref("agents.list.0.model", "openai/gpt-5.6"),
      ref("agents.list.1.utilityModel", "anthropic/claude-sonnet-4-6"),
    ]);
  });

  it("ignores a shadowed legacy list when keyed entries are authoritative", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          entries: { ops: { model: "openai/gpt-5.6" } },
          list: [{ id: "stale", model: "anthropic/claude-opus-4-8" }],
        },
      }),
    ).toEqual([ref("agents.entries.ops.model", "openai/gpt-5.6")]);
  });

  it.each([
    {
      name: "global exec reviewer selector",
      config: {
        tools: {
          exec: {
            reviewer: {
              model: { primary: "global-primary/model", fallbacks: ["global-fallback/model"] },
            },
          },
        },
      },
      expected: [
        ref("tools.exec.reviewer.model.primary", "global-primary/model"),
        ref("tools.exec.reviewer.model.fallbacks.0", "global-fallback/model"),
      ],
    },
    {
      name: "media preferences",
      config: {
        tools: {
          media: {
            image: { preferredModel: "image-provider/model" },
            audio: { preferredModel: "audio-provider/model" },
            video: { preferredModel: "video-provider/model" },
          },
        },
      },
      expected: [
        ref("tools.media.image.preferredModel", "image-provider/model", "literal"),
        ref("tools.media.audio.preferredModel", "audio-provider/model", "literal"),
        ref("tools.media.video.preferredModel", "video-provider/model", "literal"),
      ],
    },
    {
      name: "keyed agent exec reviewer",
      config: {
        agents: {
          entries: {
            worker: {
              tools: {
                exec: {
                  reviewer: {
                    model: {
                      primary: "entry-review-primary/model",
                      fallbacks: ["entry-review-fallback/model"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      expected: [
        ref(
          "agents.entries.worker.tools.exec.reviewer.model.primary",
          "entry-review-primary/model",
        ),
        ref(
          "agents.entries.worker.tools.exec.reviewer.model.fallbacks.0",
          "entry-review-fallback/model",
        ),
      ],
    },
    {
      name: "legacy agent exec reviewer",
      config: {
        agents: {
          list: [{ id: "worker", tools: { exec: { reviewer: { model: "list-review/model" } } } }],
        },
      },
      expected: [ref("agents.list.0.tools.exec.reviewer.model", "list-review/model")],
    },
    {
      name: "keyed agent TTS summary",
      config: { agents: { entries: { worker: { tts: { summaryModel: "entry-tts/model" } } } } },
      expected: [ref("agents.entries.worker.tts.summaryModel", "entry-tts/model")],
    },
    {
      name: "Discord root voice model",
      config: { channels: { discord: { voice: { model: "discord-voice/model" } } } },
      expected: [ref("channels.discord.voice.model", "discord-voice/model")],
    },
    {
      name: "Discord root voice TTS summary",
      config: { channels: { discord: { voice: { tts: { summaryModel: "discord-tts/model" } } } } },
      expected: [ref("channels.discord.voice.tts.summaryModel", "discord-tts/model")],
    },
    {
      name: "Discord account voice model",
      config: {
        channels: { discord: { accounts: { work: { voice: { model: "account-voice/model" } } } } },
      },
      expected: [ref("channels.discord.accounts.work.voice.model", "account-voice/model")],
    },
    {
      name: "Discord account voice TTS summary",
      config: {
        channels: {
          discord: {
            accounts: { work: { voice: { tts: { summaryModel: "account-tts/model" } } } },
          },
        },
      },
      expected: [ref("channels.discord.accounts.work.voice.tts.summaryModel", "account-tts/model")],
    },
  ])("collects $name", ({ config, expected }) => {
    expect(collectConfiguredModelRefs(config)).toEqual(expected);
  });

  it.each([{}, null])("does not inspect a shadow list when entries is %j", (entries) => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          entries,
          list: [{ id: "shadow", tools: { exec: { reviewer: { model: "shadow/model" } } } }],
        },
      }),
    ).toEqual([]);
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
});
