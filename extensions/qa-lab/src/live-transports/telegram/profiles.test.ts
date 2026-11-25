import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./scenario-selection.js";

describe("Telegram QA profiles", () => {
  it("selects every taxonomy-owned executable Telegram scenario through all", () => {
    const scenarioIds = resolveTelegramQaScenarioIds({
      providerMode: "mock-openai",
      profile: "all",
    });

    expect(scenarioIds).toContain("channel-message-flows");
    expect(scenarioIds).toContain("telegram-participant-identity-inspection");
    expect(scenarioIds).not.toContain("native-command-session-target");
  });

  it("lets explicit scenarios override profile selection", () => {
    expect(
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["telegram-help-command"],
      }),
    ).toEqual(["telegram-help-command"]);
    expect(() =>
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-startup-getme-live"],
      }),
    ).toThrow("execution.kind=flow");
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "mock-openai",
        scenarioIds: ["channel-canary"],
      }),
    ).toEqual(["channel-canary"]);
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "mock-openai",
        scenarioIds: ["telegram-participant-identity-inspection"],
      }),
    ).toEqual(["telegram-participant-identity-inspection"]);
  });

  it("rejects unknown profiles and channel-ineligible explicit scenarios", () => {
    expect(() =>
      resolveTelegramQaScenarioIds({ providerMode: "live-frontier", profile: "transport" }),
    ).toThrow("QA run profile must be one of");
    expect(() =>
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).toThrow("cannot run ineligible scenario(s)");
  });

  it("lists catalog-eligible scenarios with provider-specific release defaults", () => {
    const scenarios = listTelegramQaScenarios({ providerMode: "mock-openai" });
    const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode: "mock-openai" }));
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );

    expect(
      new Set(scenarios.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id)),
    ).toEqual(defaultIds);
    expect(scenarios.every(({ id }) => scenarioById.get(id)?.execution.kind === "flow")).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-reuses-preview")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-three-chunks")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-participant-identity-inspection")?.defaultEnabled,
    ).toBe(false);
    expect(scenarios.map(({ id }) => id)).not.toContain("telegram-startup-getme-live");
    expect(scenarioById.get("telegram-startup-getme-live")?.execution.kind).toBe("script");
  });
});
