// Qa Lab tests cover suite planning plugin behavior.
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  collectQaSuiteTransportPolicy,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  scenarioRequiresIsolatedQaSuiteWorker,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
} from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

function makePlaywrightQaSuiteTestScenario(id: string): ReturnType<typeof makeQaSuiteTestScenario> {
  return {
    ...makeQaSuiteTestScenario(id),
    execution: {
      kind: "playwright",
      path: `ui/src/e2e/${id}.e2e.test.ts`,
    },
  };
}

function makeMatrixFlowQaSuiteTestScenario(
  id: string,
  providerMode?: "live-frontier" | "mock-openai",
): ReturnType<typeof makeQaSuiteTestScenario> {
  return {
    ...makeQaSuiteTestScenario(id),
    execution: {
      kind: "flow",
      channel: "matrix",
      channels: ["matrix"],
      timeoutMs: 60_000,
      retryCount: 0,
      ...(providerMode ? { providerMode } : {}),
    },
  };
}

describe("qa suite planning helpers", () => {
  it("normalizes blank scenario channels as unpinned", () => {
    expect(
      normalizeQaSuiteScenarioChannel(makeQaSuiteTestScenario("blank-channel", { channel: "   " })),
    ).toBeUndefined();
    expect(
      normalizeQaSuiteScenarioChannel(
        makeQaSuiteTestScenario("matrix-channel", { channel: " Matrix " }),
      ),
    ).toBe("matrix");
  });

  it("keeps programmatic suite output dirs within the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-existing-root-"));
    try {
      await expect(
        resolveQaSuiteOutputDir(repoRoot, path.join(repoRoot, ".artifacts", "qa-e2e", "custom")),
      ).resolves.toBe(path.join(repoRoot, ".artifacts", "qa-e2e", "custom"));
      await expect(
        lstat(path.join(repoRoot, ".artifacts", "qa-e2e", "custom")).then((stats) =>
          stats.isDirectory(),
        ),
      ).resolves.toBe(true);
      await expect(resolveQaSuiteOutputDir(repoRoot, "/tmp/outside")).rejects.toThrow(
        "QA suite outputDir must stay within the repo root.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates unique default suite output dirs inside the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-default-root-"));
    try {
      const firstDir = await resolveQaSuiteOutputDir(repoRoot);
      const secondDir = await resolveQaSuiteOutputDir(repoRoot);

      expect(path.dirname(firstDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
      expect(path.basename(firstDir)).toMatch(/^suite-[a-z0-9]+-[a-f0-9]{8}$/u);
      expect(secondDir).not.toBe(firstDir);
      await expect(lstat(firstDir).then((stats) => stats.isDirectory())).resolves.toBe(true);
      await expect(lstat(secondDir).then((stats) => stats.isDirectory())).resolves.toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked suite output dirs that escape the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-root-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-outside-"));
    try {
      await mkdir(path.join(repoRoot, ".artifacts"), { recursive: true });
      await symlink(outsideRoot, path.join(repoRoot, ".artifacts", "qa-e2e"), "dir");

      await expect(resolveQaSuiteOutputDir(repoRoot, ".artifacts/qa-e2e/custom")).rejects.toThrow(
        "QA suite outputDir must not traverse symlinks.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("preserves ordered independent flow instances for repeated requested IDs", () => {
    const scenarios = [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")];
    const selected = selectQaFlowSuiteScenarios({
      scenarios,
      scenarioIds: ["first", "second", "first"],
      providerMode: "mock-openai",
      primaryModel: "mock-openai/test-model",
    });
    expect(selected.map((scenario) => scenario.id)).toEqual(["first", "second", "first"]);
    expect(new Set(selected).size).toBe(3);
    expect(selected[0]).toEqual(scenarios[0]);
    expect(selected[0]).not.toBe(scenarios[0]);
    expect(selected[2]).not.toBe(selected[0]);
  });

  it("keeps explicitly requested scenarios in request order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("first"),
      makeQaSuiteTestScenario("second"),
      makeQaSuiteTestScenario("third"),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["third", "first"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["third", "first"]);
  });

  it("applies the same lane contract to explicit and implicit selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("openai-only", {
        config: { requiredProvider: "openai", requiredModel: "gpt-5.6-luna" },
      }),
      makeQaSuiteTestScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-8" },
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "live-frontier" as const,
      primaryModel: "openai/gpt-5.6-luna",
    };

    expect(selectQaFlowSuiteScenarios(lane).map((scenario) => scenario.id)).toEqual([
      "generic",
      "openai-only",
    ]);
    expect(
      selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["openai-only"] }).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["openai-only"]);
    expect(() => selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["anthropic-only"] })).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic, model=claude-opus-4-8)",
    );
  });

  it("resolves driver channels from scenario execution with explicit and default fallbacks", () => {
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [makeQaSuiteTestScenario("plain")],
      }),
    ).toBe("telegram");
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("plain"),
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
        ],
      }),
    ).toBe("slack");
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        explicitChannel: "slack",
        scenarios: [makeQaSuiteTestScenario("slack-flow", { channel: "slack" })],
      }),
    ).toBe("slack");
    expect(() =>
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        explicitChannel: "telegram",
        scenarios: [makeQaSuiteTestScenario("slack-flow", { channel: "slack" })],
      }),
    ).toThrow("--channel telegram conflicts with selected scenario execution.channel slack.");
    expect(() =>
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
          makeQaSuiteTestScenario("telegram-flow", { channel: "telegram" }),
        ],
      }),
    ).toThrow("Selected QA scenarios require multiple channels");
    expect(
      resolveQaSuiteScenarioChannels({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("plain"),
          makeQaSuiteTestScenario("matrix-flow", { channel: "matrix" }),
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
        ],
      }),
    ).toEqual(["telegram", "matrix", "slack"]);
  });

  it("isolates Matrix reaction flows that require a fresh native canary", () => {
    const scenarioIds = [
      "matrix-reaction-notification",
      "matrix-reaction-threaded",
      "matrix-reaction-not-a-reply",
      "matrix-reaction-redaction-observed",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.suiteIsolation, scenarioId).toBe("isolated");
      expect(scenario.execution.isolationReason, scenarioId).toContain("fresh canary reply");
      expect(scenarioRequiresIsolatedQaSuiteWorker(scenario), scenarioId).toBe(true);
    }
  });

  it("isolates only positive model-driven Matrix allowBots admission flows", () => {
    const isolatedScenarioIds = [
      "matrix-allowbots-mentions-mentioned-room",
      "matrix-allowbots-room-override-enables-account-off",
      "matrix-allowbots-true-unmentioned-open-room",
    ];
    const sharedScenarioIds = [
      "matrix-allowbots-default-block",
      "matrix-allowbots-self-sender-ignored",
      "matrix-mention-metadata-spoof-block",
    ];

    for (const scenarioId of isolatedScenarioIds) {
      expect(
        scenarioRequiresIsolatedQaSuiteWorker(readQaScenarioById(scenarioId)),
        scenarioId,
      ).toBe(true);
    }
    for (const scenarioId of sharedScenarioIds) {
      expect(
        scenarioRequiresIsolatedQaSuiteWorker(readQaScenarioById(scenarioId)),
        scenarioId,
      ).toBe(false);
    }
  });

  it("isolates and collects scenario-declared transport policy", () => {
    const scenario = makeQaSuiteTestScenario("sender-policy", {
      transportPolicy: {
        directMessageOnly: true,
        requireGroupMention: true,
        senderAllowlist: ["driver"],
      },
    });

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(collectQaSuiteTransportPolicy([scenario])).toEqual({
      directMessageOnly: true,
      requireGroupMention: true,
      senderAllowlist: ["driver"],
    });
  });

  it("collects unique scenario-declared bundled plugins in encounter order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic", { plugins: ["active-memory", "memory-wiki"] }),
      makeQaSuiteTestScenario("other", { plugins: ["memory-wiki", "openai"] }),
      makeQaSuiteTestScenario("plain"),
    ];

    expect(collectQaSuitePluginIds(scenarios)).toEqual(["active-memory", "memory-wiki", "openai"]);
  });

  it("merge-patches scenario startup config in encounter order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("active-memory", {
        plugins: ["active-memory"],
        gatewayConfigPatch: {
          plugins: {
            entries: {
              "active-memory": {
                config: {
                  enabled: true,
                  agents: ["qa"],
                },
              },
            },
          },
        },
      }),
      makeQaSuiteTestScenario("live-defaults", {
        gatewayConfigPatch: {
          agents: {
            defaults: {
              thinkingDefault: "minimal",
            },
          },
          plugins: {
            entries: {
              "active-memory": {
                config: {
                  transcriptDir: "qa-memory-e2e",
                },
              },
            },
          },
        },
      }),
    ];

    expect(
      applyQaSuiteGatewayConfigPatches({}, collectQaSuiteGatewayConfigPatches(scenarios)),
    ).toEqual({
      agents: {
        defaults: {
          thinkingDefault: "minimal",
        },
      },
      plugins: {
        entries: {
          "active-memory": {
            config: {
              enabled: true,
              agents: ["qa"],
              transcriptDir: "qa-memory-e2e",
            },
          },
        },
      },
    });
  });

  it("ignores prototype-mutating keys in scenario startup config patches", () => {
    const scenarios = [
      makeQaSuiteTestScenario("polluted", {
        gatewayConfigPatch: JSON.parse(
          `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
        ) as Record<string, unknown>,
      }),
    ];

    const patch = applyQaSuiteGatewayConfigPatches(
      {},
      collectQaSuiteGatewayConfigPatches(scenarios),
    );

    expect(patch).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps a scenario deletion from resurrecting baseline siblings", () => {
    // One document cannot express "delete this parent, then recreate part of
    // it": composing the two would merge the later object into the baseline and
    // keep the siblings the first scenario removed. Startup replays them in
    // order instead.
    const scenarios = [
      makeQaSuiteTestScenario("drops-tools", { gatewayConfigPatch: { tools: null } }),
      makeQaSuiteTestScenario("adds-web-search", {
        gatewayConfigPatch: { tools: { web: { search: { enabled: true } } } },
      }),
    ];
    const baseline = { tools: { profile: "coding", deny: ["shell"] } };

    expect(
      applyQaSuiteGatewayConfigPatches(baseline, collectQaSuiteGatewayConfigPatches(scenarios)),
    ).toEqual({ tools: { web: { search: { enabled: true } } } });
  });

  it("targets the selected adapter account in scenario startup config patches", () => {
    const scenarios = [readQaScenarioById("whatsapp-access-control-dm-open")];

    expect(
      applyQaSuiteGatewayConfigPatches(
        {},
        collectQaSuiteGatewayConfigPatches(scenarios, "whatsapp-alt"),
      ),
    ).toEqual({
      channels: {
        whatsapp: {
          accounts: {
            "whatsapp-alt": {
              dmPolicy: "open",
            },
          },
        },
      },
    });
  });

  it("collects gateway runtime options across selected scenarios", () => {
    const scenarios = [
      makeQaSuiteTestScenario("plain"),
      makeQaSuiteTestScenario("browser-ui", {
        plugins: ["browser"],
        gatewayRuntime: { forwardHostHome: true },
      }),
      makeQaSuiteTestScenario("otel-stdout", {
        plugins: ["diagnostics-otel"],
        gatewayRuntime: { preserveDebugArtifacts: true },
      }),
      makeQaSuiteTestScenario("blocked-channel", {
        gatewayRuntime: { allowUnhealthyStartup: true },
      }),
    ];

    expect(collectQaSuiteGatewayRuntimeOptions(scenarios)).toEqual({
      allowUnhealthyStartup: true,
      forwardHostHome: true,
      preserveDebugArtifacts: true,
    });
  });

  it.each([
    {
      reason: "explicit scenario isolation",
      makeScenario: () => makeQaSuiteTestScenario("isolated", { suiteIsolation: "isolated" }),
    },
    {
      reason: "gateway runtime changes",
      makeScenario: () =>
        makeQaSuiteTestScenario("runtime-options", { gatewayRuntime: { forwardHostHome: true } }),
    },
    {
      reason: "scenario-owned plugins",
      makeScenario: () => makeQaSuiteTestScenario("plugin", { plugins: ["diagnostics-otel"] }),
    },
    {
      reason: "memory state",
      makeScenario: () => makeQaSuiteTestScenario("memory", { surface: "memory" }),
    },
    {
      reason: "image generation setup",
      makeScenario: () =>
        makeQaSuiteTestScenario("image-generation", { config: { ensureImageGeneration: true } }),
    },
    {
      reason: "state-mutating flow calls",
      makeScenario: () => readQaScenarioById("plugin-lifecycle-hot-reload"),
    },
  ])("isolates serial runs for $reason", ({ makeScenario }) => {
    const scenario = makeScenario();

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("baseline"), scenario],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("does not isolate plain serial scenario runs", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")],
        concurrency: 1,
      }),
    ).toBe(false);
  });

  it("isolates serial runs when a flow scenario changes provider mode", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [
          makeMatrixFlowQaSuiteTestScenario("default"),
          makeMatrixFlowQaSuiteTestScenario("live-override", "live-frontier"),
        ],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("keeps concurrent runs on isolated workers", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")],
        concurrency: 2,
      }),
    ).toBe(true);
  });

  it("keeps Playwright scenarios out of implicit flow suite selections", () => {
    const scenarios = [
      makeQaSuiteTestScenario("flow"),
      makePlaywrightQaSuiteTestScenario("playwright"),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["flow"]);
  });

  it("rejects explicit Playwright scenarios in the flow suite selector", () => {
    const scenarios = [
      makeQaSuiteTestScenario("flow"),
      makePlaywrightQaSuiteTestScenario("playwright"),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["playwright"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "suite execution requires flow scenarios; unsupported scenario(s): playwright (playwright)",
    );
  });
});
