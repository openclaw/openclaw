import { describe, expect, it } from "vitest";
import {
  type ConfiguredModelRef,
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  listModelRefsFromConfigValue as listRefs,
} from "./configured-model-refs.js";

function ref(path: string, value: string, kind: ConfiguredModelRef["kind"] = "selector") {
  return { path, value, kind };
}

function nested(path: string, value: unknown) {
  return path.split(".").reduceRight<unknown>((child, key) => ({ [key]: child }), value);
}

describe("configured model refs", () => {
  it("collects string Decision roles without changing profile suffixes", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: { decisionModel: "fixture/decision@fixture:key" },
          entries: {
            worker: { decisionModel: "fixture/other" },
            disabled: { decisionModel: "" },
            invalid: { decisionModel: { primary: "fixture/not-a-selector" } },
          },
        },
        channels: { modelByChannel: { fixture: { decisionModel: "fixture/chat@profile" } } },
      }),
    ).toEqual([
      {
        ...ref("agents.defaults.decisionModel", "fixture/decision@fixture:key"),
        capability: "decision",
      },
      { ...ref("agents.entries.worker.decisionModel", "fixture/other"), capability: "decision" },
      ref("channels.modelByChannel.fixture.decisionModel", "fixture/chat@profile"),
    ]);
  });

  it("lists raw refs from one model selector without normalizing them", () => {
    expect(listRefs("  p/model  ")).toEqual(["  p/model  "]);
    const selector = Object.freeze({
      primary: " p/main ",
      fallbacks: Object.freeze(["", "p/fallback", 42, "p/fallback"]),
    });
    expect(listRefs(selector)).toEqual([" p/main ", "", "p/fallback", "p/fallback"]);
    expect(collectConfiguredModelRefs({ agents: { defaults: { model: selector } } })).toEqual([
      ref("agents.defaults.model.primary", "p/main"),
      ref("agents.defaults.model.fallbacks.1", "p/fallback"),
      ref("agents.defaults.model.fallbacks.3", "p/fallback"),
    ]);
    expect(listRefs(["openai/gpt-5.5"])).toEqual([]);
    expect(listRefs({ primary: 42, fallbacks: "openai/gpt-5.5" })).toEqual([]);
  });

  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "p/chat", fallbacks: ["p/fallback"] },
            utilityModel: "p/utility",
            mediaModels: { image: "p/image" },
            compaction: { memoryFlush: { model: "p/flush" } },
          },
          entries: { custom: { model: "p/custom", utilityModel: "p/custom-utility" } },
        },
        hooks: { mappings: [{ model: "p/hook" }] },
        tts: { summaryModel: "p/summary" },
        channels: { modelByChannel: { discord: { guild: "p/channel" } } },
      }),
    ).toEqual([
      ref("agents.defaults.model.primary", "p/chat"),
      ref("agents.defaults.model.fallbacks.0", "p/fallback"),
      ref("agents.defaults.utilityModel", "p/utility"),
      ref("agents.defaults.mediaModels.image", "p/image", "literal"),
      ref("agents.defaults.compaction.memoryFlush.model", "p/flush"),
      ref("agents.entries.custom.model", "p/custom"),
      ref("agents.entries.custom.utilityModel", "p/custom-utility"),
      ref("channels.modelByChannel.discord.guild", "p/channel"),
      ref("hooks.mappings.0.model", "p/hook"),
      ref("tts.summaryModel", "p/summary"),
    ]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "p/chat" } },
          channels: {
            modelByChannel: { discord: { guild: "p/channel" } },
            discord: { voice: { tts: { summaryModel: "discord-tts/model" } } },
          },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["p/chat", "discord-tts/model"]);
  });

  it.each([
    {
      name: "media preferences",
      config: nested("tools.media", {
        image: { preferredModel: "p/image" },
        audio: { preferredModel: "p/audio" },
        video: { preferredModel: "p/video" },
      }),
      expected: [
        ref("tools.media.image.preferredModel", "p/image", "literal"),
        ref("tools.media.audio.preferredModel", "p/audio", "literal"),
        ref("tools.media.video.preferredModel", "p/video", "literal"),
      ],
    },
    {
      name: "legacy agent exec reviewer",
      config: nested("agents.list", [
        { id: "worker", tools: { exec: { reviewer: { model: "p/review" } } } },
      ]),
      expected: [ref("agents.list.0.tools.exec.reviewer.model", "p/review")],
    },
    {
      name: "keyed agent TTS summary",
      config: nested("agents.entries.worker.tts.summaryModel", "p/tts"),
      expected: [ref("agents.entries.worker.tts.summaryModel", "p/tts")],
    },
    {
      name: "Discord account voice TTS summary",
      config: nested("channels.discord.accounts.work.voice.tts.summaryModel", "p/tts"),
      expected: [ref("channels.discord.accounts.work.voice.tts.summaryModel", "p/tts")],
    },
  ])("collects $name", ({ config, expected }) => {
    expect(collectConfiguredModelRefs(config)).toEqual(expected);
  });
});
