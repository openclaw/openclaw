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
  return path
    .split(".")
    .reduceRight<unknown>((child, key) => (key === "0" ? [child] : { [key]: child }), value);
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

it("collects media refs in capability order", () => {
  const media = ["image", "audio", "video"];
  const config = nested(
    "tools.media",
    Object.fromEntries(media.map((kind) => [kind, { preferredModel: `p/${kind}` }])),
  );
  expect(collectConfiguredModelRefs(config)).toEqual(
    media.map((kind) => ref(`tools.media.${kind}.preferredModel`, `p/${kind}`, "literal")),
  );
});

it.each<[string, ConfiguredModelRef["kind"]?]>([
  ["agents.defaults.utilityModel"],
  ["agents.defaults.mediaModels.image", "literal"],
  ["agents.defaults.compaction.model"],
  ["agents.entries.custom.model"],
  ["agents.entries.custom.utilityModel"],
  ["channels.modelByChannel.discord.guild"],
  ["hooks.mappings.0.model"],
  ["tts.summaryModel"],
  ["agents.list.0.tools.exec.reviewer.model"],
  ["agents.entries.worker.tts.summaryModel"],
  ["channels.discord.accounts.work.voice.tts.summaryModel"],
])("collects %s with its field-owned syntax", (path, kind = "selector") => {
  expect(collectConfiguredModelRefs(nested(path, "p/model"))).toEqual([ref(path, "p/model", kind)]);
});
