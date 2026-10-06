import { describe, expect, it } from "vitest";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
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

describe("qa scenario catalog", () => {
  it("keeps repo-backed scenarios YAML-only", () => {
    expect(listScenarioMarkdownPaths()).toStrictEqual([]);
  });

  it("loads the YAML pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(readQaScenarioById("image-generation-roundtrip").sourcePath).toBe(
      "qa/scenarios/media/image-generation-roundtrip.yaml",
    );
    expect(pack.scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "image-generation-roundtrip",
        "character-vibes-gollum",
        "character-vibes-c3po",
      ]),
    );
  });

  it("keeps scenario documentation and code references backed by the repository", () => {
    for (const scenario of readQaScenarioPack().scenarios) {
      const referenceGroups = [
        ["docsRefs", scenario.docsRefs],
        ["codeRefs", scenario.codeRefs],
      ] as const;

      for (const [kind, references] of referenceGroups) {
        for (const reference of references ?? []) {
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
      (scenario) =>
        scenario.execution.kind === "script" && scenario.execution.parallelSafe === true,
    );

    expect(marked.map((scenario) => scenario.id).toSorted()).toEqual(expected);
    const ssh = readQaScenarioById("gateway-ssh-tunnels");
    expect(ssh.execution).toMatchObject({
      kind: "script",
      parallelSafe: true,
      allowBlockedEvidence: true,
    });
    for (const scenarioId of [
      "cached-health-snapshot-boundaries",
      "gateway-rpc-account-health",
      "mcp-gateway-connect-startup-retry",
      "voice-call-cli-rpc-agent-tool",
    ]) {
      expect(readQaScenarioById(scenarioId).execution).toMatchObject({
        kind: "script",
        parallelSafe: false,
      });
    }
    expect(readQaScenarioById("tui-local-shell-pty").execution).toMatchObject({
      kind: "script",
      parallelSafe: false,
    });
    for (const scenarioId of ["tui-entrypoints-pty", "tui-terminal-safety-pty"]) {
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
    expect(
      scenarios
        .filter((scenario) => scenario.execution.suiteIsolation !== "isolated")
        .map((scenario) => scenario.id),
    ).toEqual([]);
    expect(
      scenarios.find((scenario) => scenario.id === "gateway-restart-unclaimed-delivery")?.execution,
    ).toMatchObject({
      suiteIsolation: "isolated",
      isolationReason: expect.stringMatching(/\S/),
    });
  });

  it("declares every release agentic scenario in the core lane", () => {
    const scenarioIds = resolveQaParityPackScenarioIds({ parityPack: "agentic" });

    expect(scenarioIds).toHaveLength(12);
    expect(scenarioIds.map((scenarioId) => readQaScenarioById(scenarioId).runtimePairLane)).toEqual(
      scenarioIds.map(() => "core"),
    );
  });

  it("keeps the pinned gateway restart scenario owned by the OpenClaw runtime", () => {
    const scenarioId = "gateway-restart-multi-live";
    const scenario = readQaScenarioById(scenarioId);
    const scenarios = readQaScenarioPack().scenarios;
    const lane = {
      providerMode: "live-frontier" as const,
      primaryModel: "openai/gpt-5.4",
    };

    expect(scenario.runtimePairLane).toBeUndefined();
    expect(scenario.execution).toMatchObject({ kind: "flow", runtime: "openclaw" });
    expect(readQaScenarioExecutionConfig(scenarioId)).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });

    const explicitIds = selectQaFlowSuiteScenarios({
      scenarios,
      scenarioIds: [scenarioId],
      ...lane,
    }).map((selected) => selected.id);
    const implicitIds = selectQaFlowSuiteScenarios({ scenarios, ...lane }).map(
      (selected) => selected.id,
    );
    const runtimePairLane = resolveQaRuntimePairLaneScenarioIds({
      scenarios,
      scenarioIds: [],
      runtimePairLanes: ["core"],
      runtimePair: true,
      ...lane,
    });

    expect(explicitIds).toEqual([scenarioId]);
    expect(implicitIds).toContain(scenarioId);
    expect(runtimePairLane.scenarioIds).not.toContain(scenarioId);
    expect(runtimePairLane.excludedLaneScenarios.map((excluded) => excluded.id)).not.toContain(
      scenarioId,
    );
    expect(runtimePairLane.excludedNonFlowScenarios.map((excluded) => excluded.id)).not.toContain(
      scenarioId,
    );
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

  it("invalidates and observes the selected account without waiting for readiness", () => {
    const scenario = requireFlowScenario(readQaScenarioById("slack-blocked-lifecycle-no-restart"));

    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: {
        slack: {
          accounts: {
            $selectedAccount: { botToken: "xoxb-intentionally-invalid-lifecycle" },
          },
        },
      },
    });
    const flow = JSON.stringify(scenario.execution.flow);
    expect(flow).toContain("transport.accountId");
    expect(flow).toContain("await env.gateway.call('channels.status'");
    expect(flow).toContain("account?.lifecycle === 'blocked'");
    expect(flow).not.toContain("account.accountId === 'default'");
    expect(flowContainsCall(scenario.execution.flow, "waitForCondition")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "waitForTransportReady")).toBe(false);
  });
});
