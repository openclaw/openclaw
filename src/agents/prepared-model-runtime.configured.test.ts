import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";

describe("configured runtime provider discovery", () => {
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
