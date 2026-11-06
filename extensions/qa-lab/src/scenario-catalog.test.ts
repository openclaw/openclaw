import { expect, it } from "vitest";
import {
  QA_AGENTIC_PARITY_SCENARIO_TITLES,
  resolveQaParityPackScenarioIds,
} from "./agentic-parity.js";
import { resolveQaRepoPath } from "./repo-path.js";
import { resolveQaRuntimePairLaneScenarioIds } from "./runtime-pair-lane-selection.js";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
  resolveQaScenarioRequiredProviderMode,
} from "./scenario-catalog.js";
import {
  flowContainsCall,
  isFlowScenario,
  listScenarioMarkdownPaths,
  requireFlowScenario,
} from "./scenario-catalog.test-utils.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";

it("keeps repo-backed scenarios YAML-only", () => {
  expect(listScenarioMarkdownPaths()).toStrictEqual([]);
});

it("contains the apply-patch parity probe to its QA workspace", () => {
  expect(readQaScenarioById("runtime-tool-apply-patch").gatewayConfigPatch).toMatchObject({
    tools: {
      fs: { workspaceOnly: true },
      exec: { applyPatch: { workspaceOnly: true } },
    },
  });
});

it("keeps scenario documentation and code references backed by the repository", () => {
  for (const scenario of readQaScenarioPack().scenarios) {
    for (const kind of ["docsRefs", "codeRefs"] as const) {
      for (const reference of scenario[kind] ?? []) {
        const resolvedReference =
          resolveQaRepoPath(import.meta.dirname, reference, "file") ??
          resolveQaRepoPath(import.meta.dirname, reference, "directory");
        expect(resolvedReference, `${scenario.id} ${kind} ${reference} exists`).not.toBeNull();
      }
    }
  }
});

it("keeps the audited parallel script allowlist exact", () => {
  const expected =
    "active-talk-agent-run-status agent-run-identity-inspection channel-health-monitor-lifecycle cli-status-health-snapshots diagnostic-events-boundary gateway-smoke gateway-ssh-tunnels gateway-stability-runtime gateway-support-export gateway-tls-pinning gateway-websocket-protocol-contracts logging-file-boundary mcp-plugin-tools-call otel-generation-config-watcher qa-otel-smoke remote-log-tailing subagent-lineage-inspection tui-command-surfaces-pty tui-editor-input-pty tui-gateway-boundary-pty tui-local-runtime-recovery-pty tui-pty-evidence-producer-contract tui-streaming-tool-cards-pty".split(
      " ",
    );
  const marked = readQaScenarioPack().scenarios.filter(
    (scenario) => scenario.execution.kind === "script" && scenario.execution.parallelSafe === true,
  );

  expect(marked.map((scenario) => scenario.id).toSorted()).toEqual(expected);
  expect(readQaScenarioById("gateway-ssh-tunnels").execution).toMatchObject({
    kind: "script",
    parallelSafe: true,
    allowBlockedEvidence: true,
  });
  for (const scenarioId of [
    "cached-health-snapshot-boundaries",
    "gateway-rpc-account-health",
    "mcp-gateway-connect-startup-retry",
    "voice-call-cli-rpc-agent-tool",
    "tui-local-shell-pty",
    "tui-entrypoints-pty",
    "tui-terminal-safety-pty",
  ]) {
    expect(readQaScenarioById(scenarioId).execution).toMatchObject({
      kind: "script",
      parallelSafe: false,
    });
  }
});

it("rejects invalid provider metadata at the catalog boundary", () => {
  const scenario = structuredClone(
    requireFlowScenario(readQaScenarioById("subagent-completion-direct-fallback")),
  );
  scenario.execution.config = {
    ...scenario.execution.config,
    requiredProviderMode: "live-frontier",
  };

  expect(() => resolveQaScenarioRequiredProviderMode(scenario)).toThrow(
    "QA scenario subagent-completion-direct-fallback declares conflicting provider modes: execution.providerMode=mock-openai, execution.config.requiredProviderMode=live-frontier",
  );

  scenario.execution.config.requiredProviderMode = "mock-ish";
  expect(() => resolveQaScenarioRequiredProviderMode(scenario)).toThrow(
    "QA scenario subagent-completion-direct-fallback declares unknown provider mode: mock-ish",
  );
});

it("requires explicit suite isolation for gateway state restart scenarios", () => {
  const scenarios = readQaScenarioPack()
    .scenarios.filter(isFlowScenario)
    .filter((scenario) =>
      flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation"),
    );

  expect(scenarios.length).toBeGreaterThan(0);
  for (const scenario of scenarios) {
    expect(scenario.execution.suiteIsolation, scenario.id).toBe("isolated");
  }
});

it("declares every release agentic scenario in the core lane", () => {
  const scenarioIds = resolveQaParityPackScenarioIds({ parityPack: "agentic" });

  expect(scenarioIds).toHaveLength(12);
  expect(scenarioIds.map((scenarioId) => readQaScenarioById(scenarioId).title)).toEqual(
    QA_AGENTIC_PARITY_SCENARIO_TITLES,
  );
  expect(scenarioIds.map((scenarioId) => readQaScenarioById(scenarioId).runtimePairLane)).toEqual(
    scenarioIds.map(() => "core"),
  );
});

it("keeps the pinned gateway restart scenario owned by the OpenClaw runtime", () => {
  const scenarioId = "gateway-restart-multi-live";
  const scenario = readQaScenarioById(scenarioId);
  const scenarios = readQaScenarioPack().scenarios;
  const lane = { providerMode: "live-frontier" as const, primaryModel: "openai/gpt-5.4" };

  expect(scenario.runtimePairLane).toBeUndefined();
  expect(scenario.execution).toMatchObject({ kind: "flow", runtime: "openclaw" });
  expect(readQaScenarioExecutionConfig(scenarioId)).toMatchObject({
    requiredProviderMode: "live-frontier",
    requiredProvider: "openai",
    requiredModel: "gpt-5.4",
  });

  const selectIds = (scenarioIds?: string[]) =>
    selectQaFlowSuiteScenarios({ scenarios, scenarioIds, ...lane }).map((selected) => selected.id);
  const runtimePairLane = resolveQaRuntimePairLaneScenarioIds({
    scenarios,
    scenarioIds: [],
    runtimePairLanes: ["core"],
    runtimePair: true,
    ...lane,
  });

  expect(selectIds([scenarioId])).toEqual([scenarioId]);
  expect(selectIds()).toContain(scenarioId);
  expect(runtimePairLane.scenarioIds).not.toContain(scenarioId);
  for (const excluded of [
    runtimePairLane.excludedLaneScenarios,
    runtimePairLane.excludedNonFlowScenarios,
  ]) {
    expect(excluded.map((entry) => entry.id)).not.toContain(scenarioId);
  }
});

it("rejects the native web-search probe from matching-provider mock lanes", () => {
  const scenario = readQaScenarioById("openai-native-web-search-live");
  const mockLane = {
    scenarios: [scenario],
    providerMode: "mock-openai" as const,
    primaryModel: "openai/gpt-5.6-luna",
  };

  expect(selectQaFlowSuiteScenarios({ ...mockLane, providerMode: "live-frontier" })).toEqual([
    scenario,
  ]);
  expect(selectQaFlowSuiteScenarios(mockLane)).toEqual([]);
  expect(() => selectQaFlowSuiteScenarios({ ...mockLane, scenarioIds: [scenario.id] })).toThrow(
    "providerMode=live-frontier",
  );
});
