// Qa Lab tests cover scenario catalog plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveQaRepoPath } from "./repo-path.js";
import {
  listQaScenarioYamlPaths,
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
import { applyQaMergePatch } from "./suite-merge-patch.js";

describe("qa scenario catalog", () => {
  const twoPartCoverageIdPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
  const agentRuntime = "agent-runtime";
  const browserUi = "control-ui";
  const codex = "openai";
  const memory = "session-memory";
  const otel = "observability";

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
    expect(fallbackConfig).not.toHaveProperty("gracefulFallbackAny");
    const fallbackFlow = JSON.stringify(
      readQaScenarioById("memory-failure-fallback").execution.flow,
    );
    expect(fallbackFlow).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(fallbackFlow).toContain('"replacePaths":["tools.deny"]');
    expect(fallbackFlow).toContain("!tools.has('memory_search')");
    expect(fallbackFlow).toContain("outbound.text.trim().length > 0");
    expect(bundledSkill.title).toBe("Bundled plugin skill runtime");
    expect(bundledSkillConfig?.pluginId).toBe("diffs");
    expect(bundledSkillConfig?.expectedSkillName).toBe("diffs");
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
    expect(cronAuthority.runtimePairLane).toBe("core");
    expect(cronAuthority.execution.config).toMatchObject({
      requiredProviderMode: "live-frontier",
    });
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

  it("uses graceful restart and isolation for Matrix replay dedupe", () => {
    const scenario = requireFlowScenario(readQaScenarioById("matrix-restart-replay-dedupe"));
    const staleSync = requireFlowScenario(readQaScenarioById("matrix-stale-sync-replay-dedupe"));

    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restart")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation")).toBe(
      false,
    );
    expect(staleSync.execution.suiteIsolation).toBe("isolated");
  });

  it("loads scenario-declared gateway runtime options from YAML", () => {
    const scenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    const otelStdout = readQaScenarioById("otel-stdout-log-smoke");
    const blockedSlack = readQaScenarioById("slack-blocked-lifecycle-no-restart");

    expect(scenario.gatewayRuntime?.forwardHostHome).toBe(true);
    expect(otelStdout.gatewayRuntime?.preserveDebugArtifacts).toBe(true);
    expect(blockedSlack.gatewayRuntime?.allowUnhealthyStartup).toBe(true);
  });

  it.each([
    ["otel-trace-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    ["otel-both-log-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    ["otel-stdout-log-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    [
      "a2a-message-tool-mirror-dedupe",
      {
        messages: { groupChat: { visibleReplies: "message_tool" } },
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
      },
      ["session.agentToAgent"],
    ],
    [
      "goal-context-survives-compaction",
      { agents: { defaults: { compaction: { keepRecentTokens: 64 } } } },
      ["agents.defaults.compaction.reserveTokens", "agents.defaults.compaction.reserveTokensFloor"],
    ],
    [
      "active-memory-preprompt-recall",
      { plugins: { entries: { "active-memory": { config: { mode: "always" } } } } },
      [],
    ],
  ] as const)(
    "keeps %s gateway config canonical and free of retired keys",
    (scenarioId, expectedPatch, retiredPaths) => {
      const gatewayConfigPatch = readQaScenarioById(scenarioId).gatewayConfigPatch;
      const gatewayConfig = applyQaMergePatch(
        { agents: { entries: { qa: { default: true } } } },
        gatewayConfigPatch,
      );

      expect(gatewayConfigPatch).toMatchObject(expectedPatch);
      expect(gatewayConfig).toMatchObject(expectedPatch);
      for (const retiredPath of retiredPaths) {
        expect(gatewayConfigPatch).not.toHaveProperty(retiredPath);
      }
    },
  );

  it("keeps session memory ranking's runtime config patch canonical", () => {
    const scenario = readQaScenarioById("session-memory-ranking");
    const patchConfigAction = scenario.execution.flow?.steps
      .flatMap((step) => step.actions)
      .find(
        (action): action is { call: "patchConfig"; args: Array<{ patch: unknown }> } =>
          typeof action === "object" &&
          action !== null &&
          "call" in action &&
          action.call === "patchConfig" &&
          "args" in action &&
          Array.isArray(action.args),
      );
    const patch = patchConfigAction?.args[0]?.patch;

    expect(patch).toMatchObject({
      tools: { sessions: { visibility: "all" } },
      memory: {
        search: {
          sources: ["memory", "sessions"],
          experimental: { sessionMemory: true },
          query: { minScore: 0 },
        },
      },
    });
    expect(patch).not.toHaveProperty("memory.search.query.hybrid");
  });

  it("reserves Gateway-hosted Control UI proof for the real Gateway flow", () => {
    const coverageId = `${browserUi}.gateway-hosted-ui-control`;
    const primaryOwnerIds = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.coverage?.primary.includes(coverageId))
      .map((scenario) => scenario.id);
    expect(primaryOwnerIds).toStrictEqual(["control-ui-qa-channel-image-roundtrip"]);

    for (const scenario of [
      readQaScenarioById("control-ui-chat-flow-playwright"),
      readQaScenarioById("control-ui-progress-card-live-placement"),
    ]) {
      expect(scenario.execution.kind, scenario.id).toBe("playwright");
      expect(scenario.coverage?.primary, scenario.id).not.toContain(coverageId);
      expect(scenario.coverage?.secondary, scenario.id).toContain(coverageId);
    }

    const hostedScenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    expect(hostedScenario.execution).toMatchObject({ kind: "flow", channel: "qa-channel" });
    expect(hostedScenario.coverage?.primary).toContain(coverageId);
  });

  // oxfmt-ignore
  it.each([
    [`${agentRuntime}.progress-visibility-failure-recovery`, "empty-response-retry-budget-exhausted", "empty-response-recovery-replay-safe-read"],
    [`${agentRuntime}.failure-recovery-retry-policy`, "empty-response-recovery-replay-safe-read", "reasoning-only-no-auto-retry-after-write"],
  ] as const)("keeps %s on its canonical primary owner", (coverageId, primaryOwnerId, secondaryScenarioId) => {
    const primaryOwnerIds = readQaScenarioPack().scenarios.filter((scenario) => scenario.coverage?.primary.includes(coverageId)).map((scenario) => scenario.id);
    const secondaryScenario = readQaScenarioById(secondaryScenarioId);
    expect(primaryOwnerIds, coverageId).toStrictEqual([primaryOwnerId]); expect(secondaryScenario.coverage?.primary, secondaryScenarioId).not.toContain(coverageId);
    expect(secondaryScenario.coverage?.secondary, secondaryScenarioId).toContain(coverageId);
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

  it("marks only non-assistant runtime parity fixtures as usage not applicable", () => {
    const notApplicable = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.runtimeParityUsage?.expectation === "not-applicable")
      .map((scenario) => scenario.id)
      .toSorted();

    expect(notApplicable).toStrictEqual(["codex-plugin-cold-install"]);
    for (const scenarioId of notApplicable) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimePairLane).toBeDefined();
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

  it("loads the Matrix room block streaming provider override", () => {
    expect(readQaScenarioById("matrix-room-block-streaming").execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 75_000,
    });
  });

  it("separates Codex install, package compatibility, and drift diagnostics evidence", () => {
    const coldInstall = readQaScenarioById("codex-plugin-cold-install");
    expect(coldInstall.runtimePairLane).toBe("core");
    expect(coldInstall.coverage?.primary).toEqual(["plugins.lifecycle-hot-install"]);
    expect(coldInstall.coverage?.secondary).toBeUndefined();
    expect(coldInstall.execution.kind).toBe("script");

    const compatibility = readQaScenarioById("plugin-package-runtime-compatibility");
    expect(compatibility.runtimePairLane).toBeUndefined();
    expect(compatibility.runtimeParityUsage).toBeUndefined();
    expect(compatibility.coverage).toEqual({
      primary: ["plugins.runtime-compatibility"],
      secondary: ["plugins.validation-feedback"],
    });
    expect(compatibility.execution).toMatchObject({
      kind: "vitest",
      path: "src/plugins/install-compatibility.test.ts",
    });

    const driftDiagnostics = readQaScenarioById("official-plugin-version-drift-doctor");
    expect(driftDiagnostics.runtimePairLane).toBeUndefined();
    expect(driftDiagnostics.runtimeParityUsage).toBeUndefined();
    expect(driftDiagnostics.coverage).toEqual({
      primary: [`${codex}.doctor-diagnostics`],
    });
    expect(driftDiagnostics.execution).toMatchObject({
      kind: "vitest",
      path: "src/commands/doctor-workspace-status.plugin-version-drift.test.ts",
    });

    expect(readQaScenarioPack().scenarios.map((scenario) => scenario.id)).not.toEqual(
      expect.arrayContaining(["codex-plugin-pinned-old", "codex-plugin-pinned-new"]),
    );
  });

  it("routes the Codex doctor migration row through the product-backed Vitest", () => {
    const scenario = readQaScenarioById("auth-profile-doctor-migration-safety");

    expect(scenario.runtimePairLane).toBeUndefined();
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

    expect(scenario.runtimePairLane).toBeUndefined();
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

  it("keeps provider-sensitive QA flow scenarios on their supported lanes", () => {
    const strandedConfig = readQaScenarioExecutionConfig("message-tool-stranded-final-reply") as
      | { requiredProviderMode?: string }
      | undefined;
    const retryFailureConfig = readQaScenarioExecutionConfig(
      "message-tool-stranded-final-retry-failure",
    ) as { requiredProviderMode?: string } | undefined;
    const stranded = readQaScenarioById("message-tool-stranded-final-reply");
    const retryFailure = readQaScenarioById("message-tool-stranded-final-retry-failure");

    expect(strandedConfig?.requiredProviderMode).toBe("mock-openai");
    expect(retryFailureConfig?.requiredProviderMode).toBe("mock-openai");
    expect(JSON.stringify(stranded.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(JSON.stringify(retryFailure.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
  });

  it.each([
    "inbound-media-store-audio-transcription",
    "active-memory-cold-first-turn-trigger-recall",
    "compaction-empty-response-recovery",
    "compaction-reasoning-only-recovery",
    "compaction-retry-mutating-tool",
    "empty-response-recovery-replay-safe-read",
    "empty-response-retry-budget-exhausted",
    "reasoning-only-no-auto-retry-after-write",
    "reasoning-only-recovery-replay-safe-read",
  ])("keeps strict mock-only scenario %s on the mock-openai lane", (scenarioId) => {
    const config = readQaScenarioExecutionConfig(scenarioId) as
      | { requiredProviderMode?: string }
      | undefined;

    expect(config?.requiredProviderMode).toBe("mock-openai");
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

  it("keeps Anthropic thinking recovery on its resolved replay-safe mock route", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("anthropic-thinking-error-recovery-replay-safe-read"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.config).toMatchObject({
      requiredProviderMode: "mock-openai",
      anthropicModelRef: "anthropic/claude-opus-4-8",
    });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      agents: { defaults: { models: { "anthropic/claude-opus-4-8": { params: {} } } } },
      tools: { codeMode: { enabled: false } },
    });
    expect(flow).toContain("modelAck.resolved?.modelProvider === 'anthropic'");
    expect(flow).toContain("modelAck.resolved?.model === 'claude-opus-4-8'");
    expect(flow).toContain('"set":"scenarioPrompt"');
    expect(flow).toContain("`${config.prompt} QA scenario run: ${sessionKey}`");
    expect(flow).toContain('"message":{"expr":"scenarioPrompt"}');
    expect(flow).toContain("effectiveToolIds.includes('read')");
    expect(flow).toContain('"call":"runAgentPrompt"');
    expect(flow).toContain('"provider":"anthropic"');
    expect(flow).toContain('"model":"claude-opus-4-8"');
    expect(flow).toContain("/debug/requests?after=${requestCursorBefore}");
    expect(flow).toContain("request.plannedToolName === 'read'");
    expect(flow).toContain(").length >= 3");
    expect(flow).toContain("!scenarioRequests.some((request)");
    expect(flow).toContain("config.visibleAnswerRetryNeedle");
    expect(flow).toContain('"sinceIndex":{"ref":"outboundStartIndex"}');
    const requestEvidenceIndex = flow.indexOf('"set":"scenarioRequests"');
    expect(requestEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestEvidenceIndex).toBeLessThan(flow.indexOf('"call":"waitForOutboundMessage"'));
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

  it("keeps portable thread relation flows on channels with native thread semantics", () => {
    const expectations = [
      {
        scenarioId: "thread-follow-up",
        channels: ["qa-channel", "buzz", "slack", "matrix"],
      },
      { scenarioId: "thread-isolation", channels: ["qa-channel", "slack", "matrix"] },
    ];

    for (const { scenarioId, channels } of expectations) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));

      expect(scenario.execution.channel, scenarioId).toBeUndefined();
      expect(scenario.execution.channels, scenarioId).toEqual(channels);
    }
  });

  it("keeps Matrix subagent thread spawn explicitly selectable", () => {
    const scenario = readQaScenarioById("subagent-thread-spawn");

    expect(scenario.execution.channel).toBe("matrix");
  });

  it("keeps the Control UI transcript role boundary in the mock lane", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("control-ui-assistant-transcript-role-boundary"),
    );

    expect(scenario.execution.providerMode).toBe("mock-openai");
  });

  it("keeps remember-across-conversations isolated and product-only", () => {
    const scenario = requireFlowScenario(readQaScenarioById("remember-across-conversations"));
    const config = readQaScenarioExecutionConfig("remember-across-conversations") as
      | { requiredChannelDriver?: string }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(config?.requiredChannelDriver).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      session: { dmScope: "per-channel-peer" },
      memory: { search: { rememberAcrossConversations: true } },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: { enabled: true, mode: "always", agents: [] },
          },
        },
      },
    });
    expect(flow).toContain("[sourceSessionKey, targetSessionKey, groupSessionKey]");
    expect(flow).toContain("readSessionTranscriptSummary");
    expect(flow).toContain("transcript.eventCursor > 0");
    expect(flow).toContain(
      "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length",
    );
    expect(flow).toContain('"saveAs":"pauseCommandOutbound"');
    expect(flow).toContain("candidate.conversation.id === config.pausedConversationId");
    expect(flow).toContain('"sinceIndex":{"ref":"pauseCommandStartIndex"}');
    expect(flow).not.toContain('"call":"sleep"');
    expect(flow).not.toContain(".sessionFile");
  });
});
