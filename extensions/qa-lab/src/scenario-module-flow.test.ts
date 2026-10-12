import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { buildQaSuiteEvidenceSummary } from "./evidence-summary.js";
import type { QaScenarioFlow, QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { qaScenarioModuleFlow } from "./scenario-module-flow.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";

async function runModuleEvidence(moduleResult: Record<string, unknown>) {
  const moduleSource = [
    "export async function runScenario() {",
    `  return ${JSON.stringify({ details: "reply matched", ...moduleResult })};`,
    "}",
  ].join("\n");
  const moduleFlow = qaScenarioModuleFlow.moduleSchema.parse({
    module: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    call: "runScenario",
  });
  const flow = qaScenarioModuleFlow.resolveFlow(moduleFlow, "Discord canary") as QaScenarioFlow;
  const scenario = {
    id: "discord-canary",
    title: "Discord canary",
    sourcePath: "qa/scenarios/discord-canary.yaml",
    surface: "discord",
    objective: "measure Discord reply latency",
    successCriteria: ["matched reply records RTT"],
    execution: { kind: "flow", flow, flowKind: "module" },
  } satisfies QaSeedScenarioWithSource;

  const result = await runScenarioFlow({
    api: {
      state: createQaBusState(),
      scenario,
      config: {},
      runScenario: runQaSuiteScenarioSteps,
    },
    flow,
    scenarioTitle: scenario.title,
  });
  const evidence = buildQaSuiteEvidenceSummary({
    artifactPaths: [],
    channelId: "discord",
    generatedAt: "2026-09-03T00:00:00.000Z",
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    scenarioDefinitions: [scenario],
    scenarioResults: [result],
  });
  return { result, evidence };
}

describe("QA scenario module flow", () => {
  it.each([
    ["incomplete structured measurement", { rttMeasurement: { finalMatchedReplyRttMs: 1750 } }],
    ["top-level RTT", { rttMs: 1750 }],
  ])("carries %s from a module result into final QA evidence", async (_label, timingResult) => {
    const { result, evidence } = await runModuleEvidence(timingResult);

    expect(result.timing).toEqual({ rttMs: 1750 });
    expect(result.rttMeasurement).toBeUndefined();
    expect(evidence.entries[0]?.result.timing).toEqual({ rttMs: 1750 });
    expect(evidence.entries[0]?.result.rttMeasurement).toBeUndefined();
  });

  it("preserves complete structured RTT provenance as the canonical measurement", async () => {
    const rttMeasurement = {
      finalMatchedReplyRttMs: 1750,
      requestStartedAt: "2026-09-03T00:00:00.000Z",
      responseObservedAt: "2026-09-03T00:00:01.750Z",
      source: "request-to-observed-message",
    };
    const { result, evidence } = await runModuleEvidence({
      timing: { rttMs: 999 },
      rttMeasurement,
    });

    expect(result).toMatchObject({
      timing: { rttMs: 1750 },
      rttMeasurement,
    });
    expect(evidence.entries[0]?.result).toMatchObject({
      timing: { rttMs: 1750 },
      rttMeasurement,
    });
  });

  it("rejects malformed module export arguments", () => {
    expect(() =>
      qaScenarioModuleFlow.moduleSchema.parse({
        module: "./scenario-runtime.js",
        call: "runScenario",
        args: [{ moduleExport: "" }],
      }),
    ).toThrow("moduleExport arguments require a non-empty string export name");
  });
});
