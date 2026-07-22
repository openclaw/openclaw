import { describe, expect, it } from "vitest";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
} from "./scenario-catalog.js";

describe("qa scenario catalog", () => {
  it("keeps the character eval scenario natural and task-shaped", () => {
    const characterConfig = readQaScenarioExecutionConfig("character-vibes-gollum") as
      | {
          workspaceFiles?: Record<string, string>;
          turns?: Array<{ text?: string; expectFile?: { path?: string } }>;
        }
      | undefined;

    const turnTexts = characterConfig?.turns?.map((turn) => turn.text ?? "") ?? [];

    expect(characterConfig?.workspaceFiles?.["SOUL.md"]).toContain("# This is your character");
    expect(turnTexts.join("\n")).toContain("precious-status.html");
    expect(turnTexts.join("\n")).not.toContain("How would you react");
    expect(turnTexts.join("\n")).not.toContain("character check");
    expect(
      characterConfig?.turns?.some((turn) => turn.expectFile?.path === "precious-status.html"),
    ).toBe(true);
  });

  it("includes the codex leak scenario in the YAML pack", () => {
    const pack = readQaScenarioPack();
    const scenario = pack.scenarios.find(
      (candidate) => candidate.id === "codex-harness-no-meta-leak",
    );

    expect(scenario?.sourcePath).toBe("qa/scenarios/models/codex-harness-no-meta-leak.yaml");
    expect(scenario?.execution.flow?.steps.map((step) => step.name)).toContain(
      "keeps codex coordination chatter out of the visible reply",
    );
  });

  it("includes the GPT-5.6 Luna thinking visibility switch scenario", () => {
    const scenario = readQaScenarioById("luna-thinking-visibility-switch");
    const config = readQaScenarioExecutionConfig("luna-thinking-visibility-switch") as
      | {
          liveProvider?: string;
          requiredModel?: string;
          offDirective?: string;
          maxDirective?: string;
          reasoningDirective?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/luna-thinking-visibility-switch.yaml");
    expect(config?.liveProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.6-luna");
    expect(config?.offDirective).toBe("/think off");
    expect(config?.maxDirective).toBe("/think medium");
    expect(config?.reasoningDirective).toBe("/reasoning on");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "enables reasoning display and disables thinking",
      "switches to medium thinking",
      "verifies medium thinking reaches the provider",
    ]);
  });

  it("includes the OpenAI native web search live scenario", () => {
    const scenario = readQaScenarioById("openai-native-web-search-live");
    const config = readQaScenarioExecutionConfig("openai-native-web-search-live") as
      | {
          requiredProvider?: string;
          requiredModel?: string;
          expectedMarker?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/openai-native-web-search-live.yaml");
    expect(scenario.gatewayConfigPatch?.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: null,
        },
      },
    });
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.6-luna");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.6 Luna web search auto mode",
      "searches official OpenAI News through the live model",
    ]);
  });

  it("includes the Kitchen Sink live OpenAI plugin gauntlet", () => {
    const scenario = readQaScenarioById("kitchen-sink-live-openai");
    const config = readQaScenarioExecutionConfig("kitchen-sink-live-openai") as
      | {
          requiredProviderMode?: string;
          requiredProvider?: string;
          pluginSpec?: string;
          pluginId?: string;
          pluginPersonality?: string;
          adversarialPersonality?: string;
          expectedSurfaceIds?: Record<string, string[]>;
          expectedAdversarialDiagnostics?: string[];
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/plugins/kitchen-sink-live-openai.yaml");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.pluginSpec).toBe("npm:@openclaw/kitchen-sink@latest");
    expect(JSON.stringify(scenario.execution.flow)).toContain('"--force"');
    expect(config?.pluginId).toBe("openclaw-kitchen-sink-fixture");
    expect(config?.pluginPersonality).toBe("conformance");
    expect(config?.adversarialPersonality).toBe("adversarial");
    expect(config?.expectedSurfaceIds?.webSearchProviderIds).toContain(
      "kitchen-sink-web-search-provider",
    );
    expect(config?.expectedSurfaceIds?.realtimeVoiceProviderIds).toContain(
      "kitchen-sink-realtime-voice-provider",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "agent tool result middleware must be a function",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "trusted tool policy registration requires id, description, and evaluate()",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "hosted media resolver registration missing resolver",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "plugin must declare contracts.embeddingProviders for adapter: kitchen-sink-embedding-provider",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "model catalog provider registration missing provider",
    );
    expect(
      config?.expectedAdversarialDiagnostics?.every((entry) => typeof entry === "string"),
    ).toBe(true);
    expect(JSON.stringify(scenario.execution.flow)).toContain("--runtime");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "installs and inspects the Kitchen Sink plugin",
      "restarts gateway with Kitchen Sink configured",
      "exercises command inventory and MCP tool surfaces",
      "runs live OpenAI turn with Kitchen Sink loaded",
      "records gateway CPU RSS and log anomaly evidence",
      "verifies adversarial diagnostics personality",
    ]);
  });

  it("keeps provider-sensitive QA flow scenarios on their supported lanes", () => {
    const strandedConfig = readQaScenarioExecutionConfig("message-tool-stranded-final-reply") as
      | { requiredProviderMode?: string }
      | undefined;
    const retryFailureConfig = readQaScenarioExecutionConfig(
      "message-tool-stranded-final-retry-failure",
    ) as { requiredProviderMode?: string } | undefined;
    const stranded = readQaScenarioById("message-tool-stranded-final-reply");
    const retryFailure = readQaScenarioById("message-tool-stranded-final-retry-failure");
    const heartbeat = readQaScenarioById("commitments-heartbeat-target-none");
    const heartbeatFlow = JSON.stringify(heartbeat.execution.flow);

    expect(strandedConfig?.requiredProviderMode).toBe("mock-openai");
    expect(retryFailureConfig?.requiredProviderMode).toBe("mock-openai");
    expect(JSON.stringify(stranded.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(JSON.stringify(retryFailure.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(heartbeatFlow).toContain("sessionKey");
    expect(heartbeatFlow).toContain("commitmentOutbound.length === 0");
    expect(heartbeatFlow).not.toContain("waitForNoOutbound");
  });

  it("includes the thinking slash model remap scenario", () => {
    const scenario = readQaScenarioById("thinking-slash-model-remap");
    const config = readQaScenarioExecutionConfig("thinking-slash-model-remap") as
      | {
          requiredProviderMode?: string;
          anthropicModelRef?: string;
          openAiXhighModelRef?: string;
          noXhighModelRef?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/thinking-slash-model-remap.yaml");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.anthropicModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(config?.openAiXhighModelRef).toBe("openai/gpt-5.5");
    expect(config?.noXhighModelRef).toBe("anthropic/claude-sonnet-4-6");
    const flowText = JSON.stringify(scenario.execution.flow);
    expect(flowText).toContain("include max and omit xhigh");
    expect(flowText).not.toContain("omit xhigh/max");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "selects Anthropic and verifies adaptive options",
      "maps adaptive to medium when switching to OpenAI",
      "maps xhigh to high on a model without xhigh",
    ]);
  });

  it("includes the seeded mock-only broken-turn scenarios in the YAML pack", () => {
    const scenarioIds = [
      "reasoning-only-recovery-replay-safe-read",
      "reasoning-only-no-auto-retry-after-write",
      "empty-response-recovery-replay-safe-read",
      "empty-response-retry-budget-exhausted",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      const config = readQaScenarioExecutionConfig(scenarioId) as
        | {
            requiredProvider?: string;
            prompt?: string;
          }
        | undefined;

      expect(scenario.sourcePath).toBe(`qa/scenarios/runtime/${scenarioId}.yaml`);
      expect(config?.requiredProvider).toBe("mock-openai");
      expect(config?.prompt).toContain("check");
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
    }
  });

  it("keeps mock-only image debug assertions guarded in live-frontier runs", () => {
    const scenario = readQaScenarioPack().scenarios.find(
      (candidate) => candidate.id === "image-understanding-attachment",
    );
    const imageRequestAction = scenario?.execution.flow?.steps
      .flatMap((step) => step.actions ?? [])
      .find(
        (
          action,
        ): action is {
          set: string;
          value?: { expr?: string };
        } =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "imageRequest",
      );
    const imageRequestExpr = imageRequestAction?.value?.expr;

    expect(imageRequestExpr).toContain("env.mock ?");
    expect(imageRequestExpr).toContain("/debug/requests");
  });

});
