import { describe, expect, it } from "vitest";
import { readQaScenarioById, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { resolveQaScenarioRuntimeRoute } from "./suite-runtime-route.js";

const discoveryModels = {
  primaryModel: "openai/gpt-5.5",
  alternateModel: "openai/gpt-5.5",
};

describe("resolveQaScenarioRuntimeRoute", () => {
  it.each([
    "runtime-tool-session-status",
    "runtime-tool-sessions-spawn",
    "runtime-tool-web-fetch",
    "runtime-tool-web-search",
    "native-image-generation",
  ])("routes the selected native discovery lane and direct control: %s", (id) => {
    const scenario = readQaScenarioById(id);
    expect(resolveQaScenarioRuntimeRoute(scenario, "live-frontier", discoveryModels)).toEqual([
      { runtime: "codex", runtimeSelection: "configured", scenario },
    ]);
  });

  it("does not turn the live-only route into forced mock runtime selection", () => {
    const scenario = readQaScenarioById("runtime-tool-web-search");
    expect(resolveQaScenarioRuntimeRoute(scenario, "mock-openai", discoveryModels)).toEqual([]);
  });

  it.each([
    {},
    { primaryModel: "openai/gpt-5.5" },
    { alternateModel: "openai/gpt-5.5" },
    { primaryModel: "openai/gpt-5.6-luna", alternateModel: "openai/gpt-5.6-luna" },
    { primaryModel: "openai/gpt-5.5", alternateModel: "openai/gpt-5.6-luna" },
    { primaryModel: "openai/gpt-5.6-luna", alternateModel: "openai/gpt-5.5" },
  ])("requires both caller-selected discovery model slots: %j", (selection) => {
    const scenario = readQaScenarioById("runtime-tool-web-search");
    expect(resolveQaScenarioRuntimeRoute(scenario, "live-frontier", selection)).toEqual([]);
  });

  it.each([
    { forcedRuntime: "openclaw" as const },
    { forcedRuntime: "codex" as const },
    { runtimePair: ["openclaw", "codex"] as ["openclaw", "codex"] },
  ])("preserves explicitly selected runtime cells: %j", (selection) => {
    const scenario = readQaScenarioById("runtime-tool-web-search");
    expect(
      resolveQaScenarioRuntimeRoute(scenario, "live-frontier", {
        ...discoveryModels,
        ...selection,
      }),
    ).toEqual([]);
  });

  it("retains explicit forced scenario runtime routes", () => {
    const scenario = {
      ...readQaScenarioById("runtime-tool-web-search"),
      execution: { kind: "flow", runtime: "codex" },
    } as QaSeedScenarioWithSource;
    expect(resolveQaScenarioRuntimeRoute(scenario, "live-frontier", discoveryModels)).toEqual([
      { runtime: "codex", runtimeSelection: "forced", scenario },
    ]);
  });
});
