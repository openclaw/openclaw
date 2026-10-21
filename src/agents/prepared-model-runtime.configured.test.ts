import { describe, expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPreparedModelRuntimeConfiguredRefs as collectRefs,
  collectPreparedModelRuntimeProviderIds as providerIds,
} from "./prepared-model-runtime.configured.js";

const defaults = (value: AgentDefaultsConfig): OpenClawConfig => ({ agents: { defaults: value } });
const harness = (id: string) => ({ agentRuntime: { id } });

describe("configured runtime provider discovery", () => {
  it.each([
    ["decisionModel", "fixture/decision", false],
    ["decisionModel", "fixture/decision@fixture:key", false],
    ["decisionModel", "fixture/model", true],
    ["model", "fixture/model", true],
  ] as const)("discovers %s=%s (configured harness: %s)", (field, selection, withHarness) => {
    const config = defaults({ [field]: selection });
    if (withHarness) {
      config.models = {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid/v1",
            models: [],
            ...harness("fixture-harness"),
          },
        },
      };
    }
    const refs = collectRefs(config, "worker");
    if (!withHarness) {
      expect(refs).toEqual([
        {
          path: "agents.defaults.decisionModel",
          value: "fixture/decision",
          kind: "selector",
          capability: "decision",
        },
      ]);
    }
    expect(providerIds(config, {}, false, refs)).toEqual(
      field === "model" ? ["fixture", "fixture-harness"] : ["fixture"],
    );
    expect(config.agents?.defaults?.[field]).toBe(selection);
  });

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
    expect(collectRefs(config, "worker").map(({ value }) => value)).toEqual([
      "fixture/decision@20261018@iq4_xs",
      "fixture/literal@variant",
      "fixture/channel@profile",
    ]);
  });

  it("includes literal session selections in provider preparation", () => {
    const config = defaults({
      model: "other/default",
      models: {
        "fixture/Reader": harness("openclaw"),
        "fixture/Reader@variant": harness("fixture-harness"),
      },
    });
    const before = structuredClone(config);
    const selections = Object.freeze([
      Object.freeze({ provider: "fixture", modelId: "Reader@variant" }),
      Object.freeze({ provider: "fixture", modelId: "reader@variant" }),
    ]);
    const configured = collectRefs(config, "worker");
    const refs = collectRefs(config, "worker", selections);

    expect(refs.slice(0, configured.length)).toEqual(configured);
    expect(refs.slice(configured.length).map(({ value, kind }) => ({ value, kind }))).toEqual([
      { value: "fixture/Reader@variant", kind: "literal" },
      { value: "fixture/reader@variant", kind: "literal" },
    ]);
    expect(providerIds(config, {}, false, refs.slice(configured.length), "worker")).toEqual([
      "fixture",
      "fixture-harness",
    ]);
    expect(config).toEqual(before);
  });
});
