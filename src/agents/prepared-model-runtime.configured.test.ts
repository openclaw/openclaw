import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";

describe("configured runtime provider discovery", () => {
  it.each(["fixture/decision", "fixture/decision@fixture:key"])(
    "prepares configured Decision identity without a chat selection (%s)",
    (decisionModel) => {
      const config: OpenClawConfig = { agents: { defaults: { decisionModel } } };
      const refs = collectPreparedModelRuntimeConfiguredRefs(config, "worker");
      expect(refs).toEqual([
        {
          path: "agents.defaults.decisionModel",
          value: "fixture/decision",
          kind: "selector",
          capability: "decision",
        },
      ]);
      expect(collectPreparedModelRuntimeProviderIds(config, {}, false, refs)).toEqual(["fixture"]);
      expect(config.agents?.defaults?.decisionModel).toBe(decisionModel);
    },
  );

  it("strips only the Decision credential suffix from scoped agent refs", () => {
    const config: OpenClawConfig = {
      agents: {
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
    expect(
      collectPreparedModelRuntimeConfiguredRefs(config, "worker").map(({ value }) => value),
    ).toEqual([
      "fixture/decision@20261018@iq4_xs",
      "fixture/literal@variant",
      "fixture/channel@profile",
    ]);
  });

  it.each(["decisionModel", "model"] as const)(
    "includes a provider's configured chat harness only for chat selection (%s)",
    (field) => {
      const config: OpenClawConfig = {
        agents: { defaults: { [field]: "fixture/model" } },
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              models: [],
              agentRuntime: { id: "fixture-harness" },
            },
          },
        },
      };
      const refs = collectPreparedModelRuntimeConfiguredRefs(config, "worker");
      expect(collectPreparedModelRuntimeProviderIds(config, {}, false, refs)).toEqual(
        field === "decisionModel" ? ["fixture"] : ["fixture", "fixture-harness"],
      );
    },
  );

  it("includes literal session selections in provider preparation", () => {
    const agentId = "worker";
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "other/default",
          models: {
            "fixture/Reader": { agentRuntime: { id: "openclaw" } },
            "fixture/Reader@variant": { agentRuntime: { id: "fixture-harness" } },
          },
        },
      },
    };
    const before = structuredClone(config);
    const selections = Object.freeze([
      Object.freeze({ provider: "fixture", modelId: "Reader@variant" }),
      Object.freeze({ provider: "fixture", modelId: "reader@variant" }),
    ]);
    const configured = collectPreparedModelRuntimeConfiguredRefs(config, agentId);
    const refs = collectPreparedModelRuntimeConfiguredRefs(config, agentId, selections);

    expect(refs.slice(0, configured.length)).toEqual(configured);
    expect(refs.slice(configured.length).map(({ value, kind }) => ({ value, kind }))).toEqual([
      { value: "fixture/Reader@variant", kind: "literal" },
      { value: "fixture/reader@variant", kind: "literal" },
    ]);
    expect(
      collectPreparedModelRuntimeProviderIds(
        config,
        {},
        false,
        refs.slice(configured.length),
        agentId,
      ),
    ).toEqual(["fixture", "fixture-harness"]);
    expect(config).toEqual(before);
  });
});
