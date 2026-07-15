// Qa Lab tests cover canonical live-transport scenario delegation.
import { describe, expect, it, vi } from "vitest";

const { runQaFlowSuiteFromRuntime } = vi.hoisted(() => ({
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime,
}));
import { readQaScenarioPack } from "../../scenario-catalog.js";
import {
  assertKnownScenarioIds,
  partitionCanonicalScenarioIds,
  WHATSAPP_CANONICAL_SCENARIO_IDS,
  whatsappDefaultCanonicalScenarioIds,
  runCanonicalLiveScenarios,
} from "./canonical-scenarios.js";
import { loadNonYamlScenarioRefs } from "./live-transport-scenarios.js";

describe("canonical live-transport scenarios", () => {
  it("loads every migrated routing, command, and session-context scenario from YAML", () => {
    const whatsAppMockDefaultIds = whatsappDefaultCanonicalScenarioIds("mock-openai");
    const expectedIds = new Set<string>(WHATSAPP_CANONICAL_SCENARIO_IDS);
    const whatsappIds = new Set(
      readQaScenarioPack()
        .scenarios.filter((scenario) => expectedIds.has(scenario.id))
        .map((scenario) => scenario.id),
    );

    expect([...whatsappIds].toSorted()).toEqual([...WHATSAPP_CANONICAL_SCENARIO_IDS].toSorted());
    expect([...whatsAppMockDefaultIds].every((id) => whatsappIds.has(id))).toBe(true);
    expect(whatsappDefaultCanonicalScenarioIds("live-frontier")).toEqual(["whatsapp-help-command"]);
  });

  it("partitions canonical aliases from remaining imperative scenarios", () => {
    expect(
      partitionCanonicalScenarioIds(
        ["whatsapp-help-command", "whatsapp-canary"],
        WHATSAPP_CANONICAL_SCENARIO_IDS,
      ),
    ).toEqual({
      canonical: ["whatsapp-help-command"],
      legacy: ["whatsapp-canary"],
    });
  });

  it("rejects unknown legacy ids before either live runner starts", () => {
    expect(() =>
      assertKnownScenarioIds({
        ids: ["known", "missing"],
        knownIds: ["known"],
        laneLabel: "Demo",
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");
  });

  it("runs canonical live aliases through the runtime lab launcher", async () => {
    runQaFlowSuiteFromRuntime.mockResolvedValueOnce({ summaryPath: "/tmp/summary.json" });
    const sutOpenClawCommand = {
      executablePath: "/usr/local/bin/openclaw-telegram-sut-launcher",
      usePackagedPlugins: true,
    };

    await runCanonicalLiveScenarios({
      channelId: "telegram",
      factory: {
        id: "telegram",
        matches: () => true,
        create: vi.fn(),
      },
      options: {
        providerMode: "mock-openai",
        repoRoot: "/tmp/openclaw-repo",
        sutOpenClawCommand,
      },
      scenarioIds: ["telegram-help-command"],
    });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDriver: "live",
        channelId: "telegram",
        scenarioIds: ["telegram-help-command"],
        sutOpenClawCommand,
      }),
    );
  });

  it("removes migrated ids from non-YAML scenario ownership", async () => {
    const nonYamlIds = new Set((await loadNonYamlScenarioRefs()).map(({ id }) => id));

    for (const scenarioId of WHATSAPP_CANONICAL_SCENARIO_IDS) {
      expect(nonYamlIds.has(scenarioId), scenarioId).toBe(false);
    }
  });
});
