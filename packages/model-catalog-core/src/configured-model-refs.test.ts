import { expect, it } from "vitest";
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

it("collects string Decision roles without changing profile suffixes", () => {
  expect(
    collectConfiguredModelRefs({
      agents: {
        defaults: { decisionModel: "p/decision@p:key" },
        entries: {
          worker: { decisionModel: "fixture/other" },
          disabled: { decisionModel: "" },
          invalid: { decisionModel: { primary: "fixture/not-a-selector" } },
        },
      },
      channels: { modelByChannel: { fixture: { decisionModel: "fixture/chat@profile" } } },
    }),
  ).toEqual([
    { ...ref("agents.defaults.decisionModel", "p/decision@p:key"), capability: "decision" },
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

it.each<[unknown, ConfiguredModelRef[]]>([
  [
    nested("tools.media", {
      image: { preferredModel: "p/image" },
      audio: { preferredModel: "p/audio" },
      video: { preferredModel: "p/video" },
    }),
    [
      ref("tools.media.image.preferredModel", "p/image", "literal"),
      ref("tools.media.audio.preferredModel", "p/audio", "literal"),
      ref("tools.media.video.preferredModel", "p/video", "literal"),
    ],
  ],
  [
    nested("agents.list", [{ id: "worker", tools: { exec: { reviewer: { model: "p/review" } } } }]),
    [ref("agents.list.0.tools.exec.reviewer.model", "p/review")],
  ],
])("collects media and reviewer refs from %j", (config, expected) => {
  expect(collectConfiguredModelRefs(config)).toEqual(expected);
});

it.each([
  "agents.entries.worker.tts.summaryModel",
  "channels.discord.accounts.work.voice.tts.summaryModel",
])("collects %s", (path) => {
  expect(collectConfiguredModelRefs(nested(path, "p/tts"))).toEqual([ref(path, "p/tts")]);
});
