import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
} from "./scenario-catalog.js";
import {
  agentRuntime,
  cli,
  codex,
  otel,
} from "./scenario-catalog.test-support.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";

describe("qa scenario catalog", () => {
  it("loads runtime tool fixture metadata for standard and optional lanes", () => {
    const applyPatch = readQaScenarioById("runtime-tool-apply-patch");
    const messageTool = readQaScenarioById("runtime-tool-message-tool");
    const tavilySearch = readQaScenarioById("runtime-tool-tavily-search");
    const webFetch = readQaScenarioById("runtime-tool-web-fetch");
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
    const webFetchConfig = readQaScenarioExecutionConfig(webFetch.id);
    expect(webFetchConfig?.happyPrompt).toContain("Call web_fetch exactly once");
    expect(webFetchConfig?.happyPrompt).toContain("call it directly without tool_search");
    expect(webFetchConfig?.happyPrompt).toContain("Otherwise use tool_search to locate it first");
    expect(webFetchConfig?.happyPrompt).toContain(
      "A tool_search result alone does not complete the task",
    );
    expect(webFetchConfig?.happyPrompt).toContain("https://example.com/");
    expect(webFetchConfig?.happyPrompt).toContain("maxChars 500");
    expect(webFetchConfig?.happyPrompt).toContain("tool search qa check target=web_fetch");
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

  it("loads the Matrix room block streaming provider override", () => {
    expect(readQaScenarioById("matrix-room-block-streaming").execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 75_000,
    });
  });

  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "gateway-restart-multi-live",
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
    const gatewayRestartFlow = readQaScenarioById("gateway-restart-inflight-run").execution.flow;
    const gatewayRestartContract = JSON.stringify(gatewayRestartFlow);
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").gatewayConfigPatch),
    ).toContain('"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]');
    expect(gatewayRestartContract).toContain("plannedToolName === 'wait'");
    expect(gatewayRestartContract).toContain("lastAssistantToolNames?.includes('wait')");
    expect(gatewayRestartContract).toContain('"taskTracking":false');
    expect(gatewayRestartContract).toContain('"restartGatewayWithConfigPatch"');
    expect(gatewayRestartContract).toContain("interruptedMatches.length === 1");
    expect(gatewayRestartContract).toContain("restartNotices.length === 0");
    expect(gatewayRestartContract).toContain("dispatching restart-safe recovery");
    expect(gatewayRestartContract).toContain("[OpenClaw heartbeat poll]");
    expect(gatewayRestartContract).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(gatewayRestartContract).toContain("dmScope: 'per-channel-peer'");
    const liveMultiRestart = readQaScenarioById("gateway-restart-multi-live");
    const liveMultiRestartContract = JSON.stringify(liveMultiRestart.execution.flow);
    expect(JSON.stringify(liveMultiRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(liveMultiRestartContract).toContain("assistantToolCallCounts.exec");
    expect(liveMultiRestartContract).toContain("checkpoint");
    expect(liveMultiRestartContract).toContain("restarts=3");
    expect(liveMultiRestartContract).toContain("dmScope: 'per-channel-peer'");
    expect(liveMultiRestartContract).toContain("dispatching restart-safe recovery");
    expect(readQaScenarioExecutionConfig("gateway-restart-multi-live")).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });
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
    const claims = scenario.coverage;

    expect(claims?.primary).toContain(`${otel}.telemetry-tool-trace-visibility`);
    expect(claims?.secondary ?? []).toStrictEqual([
      `${otel}.telemetry-qa-bus`,
      `${otel}.telemetry-trace`,
    ]);
    expect(config?.expectedToolName).toBe("exec");
    expect(config?.expectedRedaction).toBe("[redacted]");
    expect(config?.searchQuery).toBe("exec");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "preserves searchable sanitized tool-call traces",
    ]);
  });

  it("loads the opt-in update.run package self-upgrade script proof", () => {
    const scenario = readQaScenarioById("update-run-package-self-upgrade");

    expect(scenario.coverage?.primary).toEqual([`${cli}.update-status-and-rpc`]);
    expect(scenario.coverage?.secondary).toEqual([`${cli}.managed-gateway-restart`]);
    expect(scenario.execution.kind).toBe("script");
    if (scenario.execution.kind !== "script") {
      throw new Error(`expected script execution, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe(
      "test/e2e/qa-lab/runtime/update-run-package-self-upgrade.ts",
    );
    expect(scenario.execution.allowBlockedEvidence).toBe(true);
    expect(scenario.execution.timeoutMs).toBe(3_600_000);
    expect(scenario.execution.args).toEqual(["--artifact-base", "${outputDir}"]);
    expect(scenario.execution.flow).toBeUndefined();
  });

  it("accepts the update.run producer's blocked evidence without destructive opt-in", async () => {
    const outputDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-update-run-blocked-"),
    );
    try {
      const result = await runQaTestFileScenarios({
        repoRoot: process.cwd(),
        outputDir,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        scenarios: [readQaScenarioById("update-run-package-self-upgrade")],
        env: {
          OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF: "0",
          OPENCLAW_QA_REF: "blocked-evidence-test",
        },
      });

      expect(result.results[0]).toMatchObject({
        status: "pass",
        producerEvidence: {
          entries: [
            {
              test: { id: "update-run-package-self-upgrade" },
              result: {
                status: "blocked",
                failure: {
                  reason:
                    "blocked destructive package self-upgrade; set OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF=1 to run",
                },
              },
            },
          ],
        },
      });
    } finally {
      await fs.promises.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("loads Codex plugin lifecycle scenarios into the standard runtime tier", () => {
    const coldInstall = readQaScenarioById("codex-plugin-cold-install");
    expect(coldInstall.runtimeParityTier).toBe("standard");
    expect(coldInstall.coverage?.primary).toEqual(["plugins.lifecycle-hot-install"]);
    expect(coldInstall.coverage?.secondary).toBeUndefined();
    expect(coldInstall.execution.kind).toBe("script");

    const fixtureScenarioIds = ["codex-plugin-pinned-old", "codex-plugin-pinned-new"];

    for (const scenarioId of fixtureScenarioIds) {
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
  });

  it("routes the Codex doctor migration row through the product-backed Vitest", () => {
    const scenario = readQaScenarioById("auth-profile-doctor-migration-safety");

    expect(scenario.runtimeParityTier).toBeUndefined();
    expect(scenario.runtimeParityUsage).toBeUndefined();
    expect(scenario.execution).toMatchObject({
      kind: "vitest",
      path: "test/e2e/qa-lab/runtime/codex-auth-doctor-migration-product-proof.e2e.test.ts",
    });
    expect(scenario.coverage?.primary).toEqual([`${codex}.codex-oauth-profiles-doctor-repair`]);
    expect(scenario.coverage?.secondary).toEqual([`${otel}.doctor-codex-plugin-auth`]);
  });

  it("routes the Codex mixed-profile row through the product-backed Vitest", () => {
    const scenario = readQaScenarioById("auth-profile-codex-mixed-profiles");

    expect(scenario.runtimeParityTier).toBeUndefined();
    expect(scenario.runtimeParityUsage).toBeUndefined();
    expect(scenario.execution).toMatchObject({
      kind: "vitest",
      path: "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    });
    expect(scenario.coverage?.primary).toEqual([`${codex}.codex-oauth-profiles-codex-plugin-auth`]);
    expect(scenario.coverage?.secondary).toEqual([
      `${agentRuntime}.auth-profile-selection-provider-selection`,
      `${codex}.codex-oauth-profiles-doctor-repair`,
    ]);
  });

});
