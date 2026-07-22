import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import {
  listQaScenarioYamlPaths,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
} from "./scenario-catalog.js";
import {
  agentRuntime,
  browserUi,
  flowContainsCall,
  isFlowScenario,
  listScenarioMarkdownPaths,
  memory,
  otel,
  requireFlowScenario,
  twoPartCoverageIdPattern,
} from "./scenario-catalog.test-support.js";

describe("qa scenario catalog", () => {
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
        .filter(
          (scenario) => !scenario.coverage?.primary.length && !scenario.coverage?.secondary?.length,
        )
        .map((scenario) => scenario.id),
    ).toStrictEqual([]);
    expect(
      pack.scenarios.every(
        (scenario) =>
          (scenario.coverage?.primary ?? []).every((coverageId) =>
            twoPartCoverageIdPattern.test(coverageId),
          ) &&
          (scenario.coverage?.secondary ?? []).every((coverageId) =>
            twoPartCoverageIdPattern.test(coverageId),
          ),
      ),
    ).toBe(true);
    const recall = readQaScenarioById("memory-recall");
    expect(recall.coverage?.primary).toContain(`${memory}.memory-recall`);
  });

  it("exposes bootstrap data from the YAML pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    const scenarioIds = catalog.scenarios.map((scenario) => scenario.id);
    expect(scenarioIds).toContain("subagent-fanout-synthesis");
    expect(
      resolveQaParityPackScenarioIds({ parityPack: "agentic" }).filter(
        (scenarioId) => !scenarioIds.includes(scenarioId),
      ),
    ).toStrictEqual([]);
  });

  it("loads scenario-specific execution config from per-scenario YAML", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
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

  it("loads explicit suite isolation metadata from per-scenario YAML", () => {
    const staleLinks = requireFlowScenario(readQaScenarioById("subagent-stale-child-links"));
    const kitchenSink = requireFlowScenario(readQaScenarioById("kitchen-sink-live-openai"));
    const cronRestart = requireFlowScenario(
      readQaScenarioById("cron-model-created-one-shot-recurring"),
    );
    const cronAuthority = requireFlowScenario(
      readQaScenarioById("cron-model-created-explicit-authority"),
    );

    expect(staleLinks.execution.suiteIsolation).toBe("isolated");
    expect(staleLinks.execution.isolationReason).toContain("gateway session");
    expect(kitchenSink.execution.suiteIsolation).toBe("isolated");
    expect(kitchenSink.execution.isolationReason).toContain("plugin/channel/tool config");
    expect(cronRestart.execution.suiteIsolation).toBe("isolated");
    expect(cronRestart.execution.retryCount).toBe(0);
    expect(JSON.stringify(cronRestart.execution.flow)).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(cronAuthority.execution.suiteIsolation).toBe("isolated");
    expect(cronAuthority.execution.retryCount).toBe(0);
    expect(cronAuthority.runtimeParityTier).toBe("live-only");
    expect(JSON.stringify(cronAuthority.gatewayConfigPatch)).toContain(
      "qa-cron-authority-operator",
    );
    const cronAuthorityFlow = JSON.stringify(cronAuthority.execution.flow);
    expect(cronAuthorityFlow).toContain("toolsAllowIsDefault");
    expect(cronAuthorityFlow).toContain("model did not submit the wildcard-policy job");
    expect(cronAuthorityFlow).toContain("model did not submit the overbroad-policy job");
    expect(cronAuthorityFlow).toContain("overbroad policy was not intersected");
    expect(cronAuthorityFlow).not.toContain("cron.run");
    expect(cronAuthorityFlow).not.toContain("waitForCronRunCompletion");
  });

  it("requires explicit suite isolation for gateway state restart scenarios", () => {
    const scenarios = readQaScenarioPack()
      .scenarios.filter(isFlowScenario)
      .filter((scenario) =>
        flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation"),
      );

    expect(scenarios.map((scenario) => scenario.id).toSorted()).toEqual([
      "active-memory-preprompt-recall",
      "cron-model-created-explicit-authority",
      "cron-model-created-one-shot-recurring",
      "kitchen-sink-live-openai",
      "matrix-post-restart-room-continue",
      "matrix-restart-resume",
      "qa-channel-reconnect-dedupe",
      "remember-across-conversations",
      "slack-restart-resume",
      "subagent-stale-child-links",
      "telegram-repeated-command-authorization",
      "whatsapp-restart-resume",
    ]);
    expect(
      scenarios
        .filter((scenario) => scenario.execution.suiteIsolation !== "isolated")
        .map((scenario) => scenario.id),
    ).toEqual([]);
  });

  it("uses only graceful gateway restart for Matrix replay dedupe", () => {
    const scenario = requireFlowScenario(readQaScenarioById("matrix-restart-replay-dedupe"));

    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restart")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation")).toBe(
      false,
    );
  });

  it("loads scenario-declared gateway runtime options from YAML", () => {
    const scenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    const otelStdout = readQaScenarioById("otel-stdout-log-smoke");

    expect(scenario.gatewayRuntime?.forwardHostHome).toBe(true);
    expect(otelStdout.gatewayRuntime?.preserveDebugArtifacts).toBe(true);
  });

  it("loads native test execution scenarios from YAML", () => {
    const scenario = readQaScenarioById("control-ui-chat-flow-playwright");
    const otelSmoke = readQaScenarioById("qa-otel-smoke");

    expect(scenario.execution.kind).toBe("playwright");
    if (scenario.execution.kind !== "playwright") {
      throw new Error(`expected Playwright scenario, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe("ui/src/e2e/chat-flow.e2e.test.ts");
    expect(scenario.execution.testNamePattern).toBe(
      "sends a chat turn through the GUI and renders the final Gateway event",
    );
    expect(scenario.execution.flow).toBeUndefined();
    expect(scenario.coverage?.primary).toContain(`${browserUi}.gateway-hosted-ui-control`);
    expect(otelSmoke.execution.kind).toBe("script");
    if (otelSmoke.execution.kind !== "script") {
      throw new Error(`expected script scenario, got ${otelSmoke.execution.kind}`);
    }
    expect(otelSmoke.execution.args).toStrictEqual([
      "--output-dir",
      "${outputDir}",
      "--logs-exporter",
      "both",
    ]);
    expect(otelSmoke.coverage?.secondary).not.toContain(`${otel}.otlp-http-traces-qa-lab`);
  });

  it("loads helper-backed HTTP API scenarios as supporting taxonomy coverage", () => {
    expect(readQaScenarioById("openai-compatible-chat-tools").coverage?.secondary).toStrictEqual([
      "gateway.openai-compatible-apis",
      `${agentRuntime}.hosted-tool-use`,
    ]);
    expect(readQaScenarioById("openai-web-search-minimal").coverage?.secondary).toEqual(
      expect.arrayContaining([
        `${agentRuntime}.reasoning-and-cache-controls`,
        "web-search.openai-native-web-search",
        "plugins.web-search-and-fetch",
      ]),
    );
    const webuiCoverage = readQaScenarioById("openwebui-openai-compatible").coverage?.secondary;
    expect(webuiCoverage).toContain("gateway.openai-compatible-apis");
    expect(webuiCoverage).toContain(`${agentRuntime}.hosted-provider-turns`);
  });

  it("routes Docker runtime scenarios through the shared lane adapter", () => {
    const scenarioLanes = [
      ["codex-plugin-cold-install", "codex-on-demand"],
      ["openai-compatible-chat-tools", "openai-chat-tools"],
      ["openai-web-search-minimal", "openai-web-search-minimal"],
      ["openwebui-openai-compatible", "openwebui"],
      ["plugin-lifecycle-probe", "plugin-lifecycle-matrix"],
      ["packaged-bundled-plugin-install-uninstall", "bundled-plugin-install-uninstall"],
    ] as const;

    for (const [scenarioId, lane] of scenarioLanes) {
      const execution = readQaScenarioById(scenarioId).execution;
      expect(execution.kind).toBe("script");
      if (execution.kind !== "script") {
        throw new Error(`expected script scenario, got ${execution.kind}`);
      }
      expect(execution.path).toBe("test/e2e/qa-lab/runtime/docker-e2e-lane.ts");
      expect(execution.args).toStrictEqual(["--lane", lane]);
    }
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

  it("marks only non-assistant runtime parity fixtures as usage not applicable", () => {
    const notApplicable = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.runtimeParityUsage?.expectation === "not-applicable")
      .map((scenario) => scenario.id)
      .toSorted();

    expect(notApplicable).toStrictEqual(
      [
        "codex-plugin-cold-install",
        "codex-plugin-pinned-new",
        "codex-plugin-pinned-old",
        "plugin-manifest-contract-health",
      ].toSorted(),
    );
    for (const scenarioId of notApplicable) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimeParityTier).toBeDefined();
      expect(scenario.runtimeParityUsage).toMatchObject({
        expectation: "not-applicable",
      });
      if (scenario.runtimeParityUsage?.expectation === "not-applicable") {
        expect(scenario.runtimeParityUsage.reason).toContain("no assistant turn runs");
      }
    }
    expect(readQaScenarioById("runtime-tool-fs-read").runtimeParityUsage).toBeUndefined();
    expect(readQaScenarioById("plugin-hook-health-sentinel").runtimeParityUsage).toBeUndefined();
  });

});
