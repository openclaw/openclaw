import { expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { providerConfig } from "./model-catalog-fixtures.test-support.js";
import {
  collectPreparedModelRuntimeConfiguredRefs as collectRefs,
  collectPreparedModelRuntimeProviderIds as providerIds,
} from "./prepared-model-runtime.configured.js";

const harness = (id: string) => ({ agentRuntime: { id } });
const runtimeIds = ["fixture", "fixture-harness"];
const provider = (fields: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  baseUrl: "https://fixture.invalid/v1",
  models: [],
  ...fields,
});

it("keeps credential-only providers out of static catalog preparation", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        inline: provider({ apiKey: "fixture-key" }),
        referenced: provider({ apiKey: { source: "file", provider: "fixture", id: "key" } }),
        blank: provider({ apiKey: " " }),
        unrelated: provider(),
      },
    },
  };
  expect(providerIds(config, {}, false, [])).toEqual([]);
  expect(providerIds(config, {}, true, [])).toEqual(["inline", "referenced"]);
});

it("prepares scoped refs and literal selections without changing config or Decision identity", () => {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "fixture/model",
        models: {
          "fixture/Reader": harness("openclaw"),
          "fixture/Reader@variant": harness("fixture-harness"),
        },
      },
      entries: {
        worker: {
          decisionModel: "fixture/decision@20261018@iq4_xs@fixture:key",
          models: { "fixture/literal@variant": {} },
        },
        other: { decisionModel: "other/model" },
      },
    },
    channels: { modelByChannel: { fixture: { decisionModel: "fixture/channel@profile" } } },
  };
  const before = structuredClone(config);
  const selections = Object.freeze([
    Object.freeze({ provider: "fixture", modelId: "Reader@variant" }),
    Object.freeze({ provider: "fixture", modelId: "reader@variant" }),
  ]);
  const refs = collectRefs(config, "worker", selections);
  expect(refs.map(({ value }) => value)).toEqual([
    "fixture/model",
    "fixture/Reader",
    "fixture/Reader@variant",
    "fixture/decision@20261018@iq4_xs",
    "fixture/literal@variant",
    "fixture/channel@profile",
    "fixture/Reader@variant",
    "fixture/reader@variant",
  ]);
  const withProvider = {
    ...config,
    ...providerConfig("fixture", provider(harness("fixture-harness"))),
  };
  const decisions = refs.filter((ref) => ref.capability === "decision");
  expect(providerIds(withProvider, {}, false, decisions)).toEqual(["fixture"]);
  expect(providerIds(withProvider, {}, false, refs.slice(0, 1))).toEqual(runtimeIds);
  expect(refs.slice(-2).map(({ kind }) => kind)).toEqual(["literal", "literal"]);
  expect(providerIds(config, {}, false, refs.slice(-2), "worker")).toEqual(runtimeIds);
  expect(config).toEqual(before);
});
