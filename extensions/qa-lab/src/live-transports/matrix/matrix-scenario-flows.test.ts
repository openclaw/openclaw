import { describe, expect, it } from "vitest";
import {
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
} from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { collectQaSuitePluginIds } from "../../suite-planning.js";

describe("Matrix QA Lab scenario flows", () => {
  const catalog = readQaBootstrapScenarioCatalog();
  const scenarios = catalog.scenarios.filter((scenario) => {
    if (scenario.execution.kind !== "flow" || scenario.execution.channel !== "matrix") {
      return false;
    }
    return scenario.execution.flow?.steps.some((step) =>
      step.actions.some(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "scenarioModule",
      ),
    );
  });

  it("prepares the shared canary only for canary-dependent scenarios", () => {
    const canaryScenarioIds = new Set([
      "matrix-reaction-not-a-reply",
      "matrix-reaction-notification",
      "matrix-reaction-redaction-observed",
      "matrix-reaction-threaded",
      "matrix-voice-preflight-mention",
    ]);
    for (const scenario of scenarios) {
      const { flow, config = {} } = requireFlowScenario(scenario).execution;
      expect(config.matrixRequireCanary === true, scenario.id).toBe(
        canaryScenarioIds.has(scenario.id),
      );
      const actions = flow?.steps.flatMap((step) => step.actions);
      const moduleImport = expect.objectContaining({
        set: "scenarioModule",
        value: expect.objectContaining({
          expr: expect.stringContaining("./live-transports/matrix/scenarios/scenario-runtime-"),
        }),
      });
      expect(actions, scenario.id).toEqual(expect.arrayContaining([moduleImport]));
      const call = expect.objectContaining({ call: expect.stringMatching(/^scenarioModule\./) });
      expect(
        actions?.find((action) => call.asymmetricMatch(action)),
        scenario.id,
      ).toEqual(expect.objectContaining({ args: [{ expr: "scenarioContext" }] }));
    }
  });

  it("isolates scenarios that assert fresh thread and DM session routing", () => {
    const expectedReasons = {
      "dm-shared-session": "pristine per-user DM session routing",
      "thread-isolation": "fresh session boundary",
      "thread-reply-override": "must not inherit an existing room session",
    } as const;

    for (const [scenarioId, reason] of Object.entries(expectedReasons)) {
      const execution = requireFlowScenario(readQaScenarioById(scenarioId)).execution;
      expect(execution.suiteIsolation, scenarioId).toBe("isolated");
      expect(execution.isolationReason, scenarioId).toContain(reason);
    }
  });

  it("loads the voice preflight provider and media overrides", () => {
    const scenario = readQaScenarioById("matrix-voice-preflight-mention");
    const models = [{ capabilities: ["audio"], model: "gpt-4o-transcribe", provider: "openai" }];
    const audio = {
      echoTranscript: true,
      enabled: true,
      prompt: "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER",
    };
    const mentionPatterns = ["matrix\\W+qa\\W+voice\\W+pre[ -]?flight\\W+ok(?:ay)?"];

    expect(scenario.execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 90_000,
    });
    expect(scenario.plugins).toEqual(["openai"]);
    expect(collectQaSuitePluginIds([scenario])).toEqual(["openai"]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: { media: { models, audio } },
      messages: { groupChat: { mentionPatterns } },
    });
    expect(readQaScenarioExecutionConfig("matrix-voice-preflight-mention")).toMatchObject({
      matrixRequireCanary: true,
      matrixConfigOverrides: {
        mediaModels: models,
        audio,
        groupMentionPatterns: mentionPatterns,
      },
    });
  });
});
