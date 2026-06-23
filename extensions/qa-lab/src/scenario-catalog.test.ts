// Qa Lab tests cover scenario catalog plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { QA_AGENTIC_PARITY_SCENARIO_IDS } from "./agentic-parity.js";
import {
  listQaScenarioYamlPaths,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
  validateQaScenarioExecutionConfig,
} from "./scenario-catalog.js";

function listScenarioMarkdownPaths(dir = "qa/scenarios"): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return listScenarioMarkdownPaths(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    })
    .toSorted();
}

describe("qa scenario catalog", () => {
  const dottedCoverageIdPattern = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

  it("keeps repo-backed scenarios YAML-only", () => {
    expect(listScenarioMarkdownPaths()).toStrictEqual([]);
  });

  it("loads the YAML pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(listQaScenarioYamlPaths().length).toBe(pack.scenarios.length);
    expect(listQaScenarioYamlPaths()).toContain(
      "qa/scenarios/media/image-generation-roundtrip.yaml",
    );
    const scenarioIds = pack.scenarios.map((scenario) => scenario.id);
    const requiredScenarioIds = [
      "image-generation-roundtrip",
      "character-vibes-gollum",
      "character-vibes-c3po",
    ].toSorted();
    expect(
      scenarioIds.filter((scenarioId) => requiredScenarioIds.includes(scenarioId)).toSorted(),
    ).toEqual(requiredScenarioIds);
    const nativeExecutionScenarios = pack.scenarios.filter(
      (scenario) => scenario.execution.kind !== "flow",
    );
    expect(nativeExecutionScenarios.length).toBeGreaterThan(0);
    for (const scenario of nativeExecutionScenarios) {
      const execution = scenario.execution;
      if (execution.kind === "flow") {
        throw new Error(`expected native execution scenario: ${scenario.id}`);
      }
      expect(["playwright", "script", "vitest"]).toContain(execution.kind);
      expect(fs.existsSync(execution.path), `${scenario.id} execution.path exists`).toBe(true);
      expect(execution.flow).toBeUndefined();
    }
    expect(
      pack.scenarios
        .filter((scenario) => scenario.execution.kind === "flow")
        .every((scenario) => (scenario.execution.flow?.steps.length ?? 0) > 0),
    ).toBe(true);
    expect(
      pack.scenarios
        .filter((scenario) => !(scenario.coverage?.primary.length ?? 0))
        .map((scenario) => scenario.id),
    ).toStrictEqual([]);
    expect(
      pack.scenarios.every(
        (scenario) =>
          (scenario.coverage?.primary ?? []).every((coverageId) =>
            dottedCoverageIdPattern.test(coverageId),
          ) &&
          (scenario.coverage?.secondary ?? []).every((coverageId) =>
            dottedCoverageIdPattern.test(coverageId),
          ),
      ),
    ).toBe(true);
    expect(readQaScenarioById("memory-recall").coverage?.primary).toContain("memory.recall");
  });

  it("exposes bootstrap data from the YAML pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    const scenarioIds = catalog.scenarios.map((scenario) => scenario.id);
    expect(scenarioIds).toContain("subagent-fanout-synthesis");
    expect(
      QA_AGENTIC_PARITY_SCENARIO_IDS.filter((scenarioId) => !scenarioIds.includes(scenarioId)),
    ).toStrictEqual([]);
  });

  it("loads scenario-specific execution config from per-scenario YAML", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
    const codexLeak = readQaScenarioById("codex-harness-no-meta-leak");
    const codexLeakConfig = readQaScenarioExecutionConfig("codex-harness-no-meta-leak") as
      | {
          harnessRuntime?: string;
          expectedReply?: string;
          forbiddenReplySubstrings?: string[];
        }
      | undefined;
    const fallbackConfig = readQaScenarioExecutionConfig("memory-failure-fallback");
    const bundledSkill = readQaScenarioById("bundled-plugin-skill-runtime");
    const bundledSkillConfig = readQaScenarioExecutionConfig("bundled-plugin-skill-runtime") as
      | { pluginId?: string; expectedSkillName?: string }
      | undefined;
    const fanoutConfig = readQaScenarioExecutionConfig("subagent-fanout-synthesis") as
      | { expectedReplyGroups?: unknown[][] }
      | undefined;

    expect(discovery.title).toBe("Source and docs discovery report");
    expect((discoveryConfig?.requiredFiles as string[] | undefined)?.[0]).toBe(
      "repo/qa/scenarios/index.yaml",
    );
    expect(codexLeak.title).toBe("Codex harness no meta leak");
    expect(codexLeakConfig?.harnessRuntime).toBe("codex");
    expect(JSON.stringify(codexLeak.execution.flow)).toContain("agentRuntime");
    expect(JSON.stringify(codexLeak.execution.flow)).not.toContain("embeddedHarness");
    expect(codexLeakConfig?.expectedReply).toBe("QA_LEAK_OK");
    expect(codexLeakConfig?.forbiddenReplySubstrings).toContain("checking thread context");
    expect(fallbackConfig?.gracefulFallbackAny as string[] | undefined).toContain(
      "will not reveal",
    );
    const fallbackFlow = JSON.stringify(
      readQaScenarioById("memory-failure-fallback").execution.flow,
    );
    expect(fallbackFlow).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(fallbackFlow).toContain('"replacePaths":["tools.deny"]');
    expect(bundledSkill.title).toBe("Bundled plugin skill runtime");
    expect(bundledSkillConfig?.pluginId).toBe("open-prose");
    expect(bundledSkillConfig?.expectedSkillName).toBe("prose");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-1: ok");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-2: ok");
  });

  it("loads scenario-declared gateway runtime options from YAML", () => {
    const scenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    const otelStdout = readQaScenarioById("otel-stdout-log-smoke");

    expect(scenario.gatewayRuntime?.forwardHostHome).toBe(true);
    expect(otelStdout.gatewayRuntime?.preserveDebugArtifacts).toBe(true);
  });

  it("loads native test execution scenarios from YAML", () => {
    const scenario = readQaScenarioById("control-ui-chat-flow-playwright");
    const uxMatrix = readQaScenarioById("ux-matrix-evidence-dashboard");

    expect(scenario.execution.kind).toBe("playwright");
    if (scenario.execution.kind !== "playwright") {
      throw new Error(`expected Playwright scenario, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe("ui/src/ui/e2e/chat-flow.e2e.test.ts");
    expect(scenario.execution.flow).toBeUndefined();
    expect(scenario.coverage?.primary).toContain("ui.control");
    expect(uxMatrix.execution.kind).toBe("script");
    if (uxMatrix.execution.kind !== "script") {
      throw new Error(`expected script scenario, got ${uxMatrix.execution.kind}`);
    }
    expect(uxMatrix.execution.path).toBe("scripts/qa/ux-matrix-evidence-producer.ts");
    expect(uxMatrix.execution.args).toStrictEqual(["--artifact-base", "${outputDir}"]);
    expect(uxMatrix.execution.config).toBeUndefined();
    expect(uxMatrix.coverage?.primary).toContain("qa.artifact-safety");
  });

  it("loads folded HTTP API script scenarios with primary taxonomy coverage", () => {
    expect(readQaScenarioById("openai-compatible-chat-tools").coverage?.primary).toStrictEqual([
      "gateway.openai-compatible-apis",
    ]);
    expect(readQaScenarioById("openai-web-search-minimal").coverage?.primary).toStrictEqual([
      "runtime.reasoning-and-cache-controls",
    ]);
    expect(
      readQaScenarioById("openai-web-search-native-assertions").coverage?.primary,
    ).toStrictEqual(["web-search.openai-native-web-search", "plugins.web-search-and-fetch"]);
    expect(readQaScenarioById("openwebui-openai-compatible").coverage?.primary).toStrictEqual([
      "gateway.openai-compatible-apis",
    ]);
  });

  it("loads runtime parity tier metadata for first-hour and soak lanes", () => {
    const firstHour = readQaScenarioById("runtime-first-hour-20-turn");
    const soak = readQaScenarioById("runtime-soak-100-turn");

    expect(firstHour.runtimeParityTier).toBe("standard");
    expect(readQaScenarioExecutionConfig(firstHour.id)).toMatchObject({
      runtimeParityComparison: "outcome-only",
      turnCount: 20,
    });
    expect(soak.runtimeParityTier).toBe("soak");
    expect(readQaScenarioExecutionConfig(soak.id)).toMatchObject({ turnCount: 100 });
  });

  it("loads runtime tool fixture metadata for standard and optional lanes", () => {
    const applyPatch = readQaScenarioById("runtime-tool-apply-patch");
    const messageTool = readQaScenarioById("runtime-tool-message-tool");
    const tavilySearch = readQaScenarioById("runtime-tool-tavily-search");
    const webSearch = readQaScenarioById("runtime-tool-web-search");
    const imageGenerate = readQaScenarioById("runtime-tool-image-generate");

    expect(applyPatch.runtimeParityTier).toBe("standard");
    expect(messageTool.runtimeParityTier).toBe("optional");
    expect(tavilySearch.runtimeParityTier).toBe("optional");
    expect(imageGenerate.runtimeParityTier).toBe("optional");
    expect(readQaScenarioExecutionConfig(applyPatch.id)).toMatchObject({
      toolName: "apply_patch",
      toolCoverage: {
        bucket: "codex-native-workspace",
        expectedLayer: "codex-native-workspace",
      },
    });
    expect(readQaScenarioExecutionConfig(messageTool.id)).toMatchObject({
      toolName: "message",
      expectedAvailable: false,
      toolCoverage: {
        bucket: "optional-profile-or-plugin",
        expectedLayer: "profile-or-plugin",
        required: false,
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).toMatchObject({
      toolName: "web_search",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: true,
      },
    });
    expect(webSearch.plugins).toEqual(["qa-lab"]);
    expect(webSearch.gatewayConfigPatch?.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: "qa-lab-search",
        },
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).not.toHaveProperty("knownHarnessGap");
    expect(readQaScenarioExecutionConfig(imageGenerate.id)).toMatchObject({
      requiredProviderMode: "mock-openai",
      toolName: "image_generate",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: false,
      },
    });
  });

  it("loads the Codex legacy Read vocabulary live parity canary", () => {
    const scenario = readQaScenarioById("codex-legacy-read-tool-vocabulary");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          runtimeParityComparison?: string;
          fixtureFile?: string;
          expectedMarker?: string;
          unavailableNeedles?: string[];
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/codex-legacy-read-tool-vocabulary.yaml");
    expect(scenario.runtimeParityTier).toBe("live-only");
    expect(config?.runtimeParityComparison).toBe("codex-native-workspace");
    expect(config?.fixtureFile).toBe("LEGACY_READ_TOOL_FIXTURE.txt");
    expect(config?.expectedMarker).toBe("LEGACY_READ_TOOL_OK");
    expect(config?.unavailableNeedles).toContain("not in my available tool surface");
  });

  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "streaming-final-integrity",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimeParityTier).toBe("live-only");
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
    }
    expect(readQaScenarioById("webchat-direct-reply-routing").sourcePath).toBe(
      "qa/scenarios/channels/webchat-direct-reply-routing.yaml",
    );
    expect(readQaScenarioById("long-context-progress-watchdog").sourcePath).toBe(
      "qa/scenarios/runtime/long-context-progress-watchdog.yaml",
    );
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("EmbeddedAttemptSessionTakeoverError");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("AbortError");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("This operation was aborted");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("liveTurnTimeoutMs(env, 180000)");
    const longContextFlow = JSON.stringify(
      readQaScenarioById("long-context-progress-watchdog").execution.flow,
    );
    expect(longContextFlow).toContain("originalCodexPluginEnabled");
    expect(longContextFlow).not.toContain(
      "originalPluginAllow === undefined ? null : originalPluginAllow",
    );
    expect(longContextFlow).not.toContain("{ ...originalCodexPluginEntry, enabled:");
    expect(readQaScenarioExecutionConfig("long-context-progress-watchdog")).toMatchObject({
      requiredProviderMode: "live-frontier",
      harnessRuntime: "codex",
    });
    expect(readQaScenarioById("long-context-progress-watchdog").plugins).toBeUndefined();
    expect(readQaScenarioById("long-context-progress-watchdog").gatewayConfigPatch).toBeUndefined();
  });

  it("loads the QA bus tool trace visibility harness scenario", () => {
    const scenario = readQaScenarioById("qa-bus-tool-trace-visibility");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          expectedToolName?: string;
          expectedRedaction?: string;
          searchQuery?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/qa-bus-tool-trace-visibility.yaml");
    expect(scenario.coverage?.primary).toContain("harness.tool-trace-visibility");
    expect(scenario.coverage?.secondary ?? []).toStrictEqual(["runtime.qa-bus", "tools.trace"]);
    expect(config?.expectedToolName).toBe("exec");
    expect(config?.expectedRedaction).toBe("[redacted]");
    expect(config?.searchQuery).toBe("exec");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "preserves searchable sanitized tool-call traces",
    ]);
  });

  it("loads the opt-in update.run package self-upgrade sentinel", () => {
    const scenario = readQaScenarioById("update-run-package-self-upgrade");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          requiredProviderMode?: string;
          allowEnv?: string;
          sourceVersion?: string;
          targetTag?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/update-run-package-self-upgrade.yaml");
    expect(scenario.coverage?.primary).toContain("runtime.update-run");
    expect(scenario.coverage?.secondary).toContain("runtime.package-update");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.allowEnv).toBe("OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF");
    expect(config?.sourceVersion).toBe("2026.4.26");
    expect(config?.targetTag).toBe("latest");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "asks the agent to self-update through update.run",
    ]);
  });

  it("loads the Codex plugin lifecycle fixture scenarios into the standard runtime tier", () => {
    const scenarioIds = [
      "codex-plugin-cold-install",
      "codex-plugin-install-race",
      "codex-plugin-pinned-old",
      "codex-plugin-pinned-new",
      "auth-profile-codex-mixed-profiles",
      "auth-profile-doctor-migration-safety",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimeParityTier).toBe("standard");
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.length).toBe(1);
    }
    expect(readQaScenarioExecutionConfig("codex-plugin-pinned-old")).toMatchObject({
      pluginVersion: "2026.5.19",
      hostVersion: "2026.5.21",
      pluginRelation: "older",
    });
    expect(readQaScenarioExecutionConfig("auth-profile-doctor-migration-safety")).toMatchObject({
      matrixCells: ["oauth-only", "mixed-no-pin"],
    });
  });

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

  it("includes the GPT-5.5 thinking visibility switch scenario", () => {
    const scenario = readQaScenarioById("gpt55-thinking-visibility-switch");
    const config = readQaScenarioExecutionConfig("gpt55-thinking-visibility-switch") as
      | {
          requiredProvider?: string;
          requiredModel?: string;
          offDirective?: string;
          maxDirective?: string;
          reasoningDirective?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/gpt55-thinking-visibility-switch.yaml");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.5");
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
    expect(config?.requiredModel).toBe("gpt-5.5");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.5 web search auto mode",
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
    const stranded = readQaScenarioById("message-tool-stranded-final-reply");
    const heartbeat = readQaScenarioById("commitments-heartbeat-target-none");
    const heartbeatFlow = JSON.stringify(heartbeat.execution.flow);

    expect(strandedConfig?.requiredProviderMode).toBe("mock-openai");
    expect(JSON.stringify(stranded.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(heartbeatFlow).toContain("sessionKey");
    expect(heartbeatFlow).toContain("targetOutbound.length === 0");
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

  it("adds a repo-instruction followthrough scenario to the parity pack", () => {
    const scenario = readQaScenarioById("instruction-followthrough-repo-contract");
    const config = readQaScenarioExecutionConfig("instruction-followthrough-repo-contract") as
      | {
          workspaceFiles?: Record<string, string>;
          prompt?: string;
          requiredChannelDriver?: string;
          expectedReplyAll?: string[];
          expectedArtifactAll?: string[];
          expectedArtifactAny?: string[];
        }
      | undefined;

    expect(config?.workspaceFiles?.["AGENT.md"]).toContain("Step order:");
    expect(config?.workspaceFiles?.["SOUL.md"]).toContain("action-first");
    expect(config?.workspaceFiles?.["FOLLOWTHROUGH_INPUT.md"]).toContain(
      "Mission: prove you followed the repo contract.",
    );
    expect(config?.prompt).toContain("Repo contract followthrough check.");
    expect(config?.requiredChannelDriver).toBe("qa-channel");
    expect(config?.expectedReplyAll).toEqual(["read:", "wrote:", "status:"]);
    expect(config?.expectedArtifactAll).toEqual(["repo contract"]);
    expect(config?.expectedArtifactAny).toContain("evidence path");
    expect(scenario.title).toBe("Instruction followthrough repo contract");
  });

  it("keeps native QA-channel fixtures out of Crabline profile selection", () => {
    const scenarioIds = [
      "subagent-forked-context",
      "subagent-handoff",
      "group-message-tool-unavailable-fallback",
      "qa-channel-reconnect-dedupe",
      "reaction-edit-delete",
      "thread-follow-up",
      "image-generation-roundtrip",
      "image-understanding-attachment",
      "native-image-generation",
      "active-memory-preprompt-recall",
      "memory-recall",
      "session-memory-ranking",
      "thread-memory-isolation",
      "personal-channel-thread-reply",
      "personal-memory-preference-recall",
      "personal-reminder-roundtrip",
      "cron-natural-fire-no-duplicate",
      "cron-one-minute-ping",
      "cron-single-run-no-duplicate",
      "control-ui-qa-channel-image-roundtrip",
      "config-apply-restart-wakeup",
    ];

    for (const scenarioId of scenarioIds) {
      const config = readQaScenarioExecutionConfig(scenarioId) as
        | { requiredChannelDriver?: string }
        | undefined;
      expect(config?.requiredChannelDriver, scenarioId).toBe("qa-channel");
    }
  });

  it("adds a dreaming shadow trial report scenario", () => {
    const scenario = readQaScenarioById("dreaming-shadow-trial-report");
    const config = readQaScenarioExecutionConfig("dreaming-shadow-trial-report") as
      | {
          prompt?: string;
          reportName?: string;
          expectedReportAll?: string[];
          forbiddenReplyNeedles?: string[];
          seededMemory?: string;
        }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.sourcePath).toBe("qa/scenarios/memory/dreaming-shadow-trial-report.yaml");
    expect(scenario.coverage?.primary).toContain("memory.dreaming");
    expect(config?.prompt).toContain("Dreaming shadow trial report check");
    expect(config?.reportName).toBe("dreaming-shadow-trial-report.md");
    expect(config?.seededMemory).toBe("# Memory\n\n");
    expect(config?.expectedReportAll).toContain("verdict: helpful");
    expect(config?.expectedReportAll).toContain("exact verification commands and remaining risk");
    expect(config?.expectedReportAll).toContain("omits the exact command and remaining risk");
    expect(config?.expectedReportAll).toContain("calls out the remaining review risk");
    expect(config?.forbiddenReplyNeedles).toContain("candidate was promoted to MEMORY.md");
    expect(flow).toContain("plannedToolName === 'write'");
    expect(flow).toContain("readIndices[1] < firstWrite");
    expect(flow).toContain("String(memoryAfter) === config.seededMemory");
  });

  it("rejects malformed string matcher lists before running a flow", () => {
    expect(() =>
      validateQaScenarioExecutionConfig({
        gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }],
      }),
    ).toThrow(/gracefulFallbackAny entries must be strings/);
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
