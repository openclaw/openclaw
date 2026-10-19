import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { makeQaSuiteTestScenario as makeScenario } from "./suite-test-helpers.js";

const roots: string[] = [];
async function makeRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Scenario = ReturnType<typeof makeScenario>;
const channelParams = (scenarios: Scenario[], explicitChannel?: string) => ({
  defaultChannel: "telegram",
  scenarios,
  explicitChannel,
});
const resolveChannel = (scenarios: Scenario[], explicitChannel?: string) =>
  resolveQaSuiteScenarioChannel(channelParams(scenarios, explicitChannel));
const applyPatches = (scenarios: Scenario[], baseline: unknown = {}, accountId?: string) =>
  applyQaSuiteGatewayConfigPatches(
    baseline,
    collectQaSuiteGatewayConfigPatches(scenarios, accountId),
  );
const mockLane = { providerMode: "mock-openai", primaryModel: "mock-openai/test-model" } as const;
const selectMock = (scenarios: Scenario[], scenarioIds: string[]) =>
  selectQaFlowSuiteScenarios({ ...mockLane, scenarios, scenarioIds });

describe("qa suite planning helpers", () => {
  it("normalizes blank scenario channels as unpinned", () => {
    const scenarios = ["   ", " Matrix "].map((channel) => makeScenario("channel", { channel }));
    expect(scenarios.map(normalizeQaSuiteScenarioChannel)).toEqual([undefined, "matrix"]);
  });

  it("keeps programmatic suite output dirs within the repo root", async () => {
    const repoRoot = await makeRoot("qa-suite-existing-root-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "custom");
    await expect(resolveQaSuiteOutputDir(repoRoot, outputDir)).resolves.toBe(outputDir);
    expect((await lstat(outputDir)).isDirectory()).toBe(true);
    await expect(resolveQaSuiteOutputDir(repoRoot, "/tmp/outside")).rejects.toThrow(
      "QA suite outputDir must stay within the repo root.",
    );
  });

  it("rejects symlinked suite output dirs that escape the repo root", async () => {
    const repoRoot = await makeRoot("qa-suite-root-");
    const outsideRoot = await makeRoot("qa-suite-outside-");
    await mkdir(path.join(repoRoot, ".artifacts"), { recursive: true });
    await symlink(outsideRoot, path.join(repoRoot, ".artifacts", "qa-e2e"), "dir");

    await expect(resolveQaSuiteOutputDir(repoRoot, ".artifacts/qa-e2e/custom")).rejects.toThrow(
      "QA suite outputDir must not traverse symlinks.",
    );
  });

  it("preserves ordered independent flow instances for repeated requested IDs", () => {
    const scenarios = [makeScenario("first"), makeScenario("second")];
    const selected = selectMock(scenarios, ["first", "second", "first"]);
    expect(selected.map((scenario) => scenario.id)).toEqual(["first", "second", "first"]);
    expect(new Set(selected).size).toBe(3);
    expect(selected[0]).toEqual(scenarios[0]);
    expect(selected[0]).not.toBe(scenarios[0]);
    expect(selected[2]).not.toBe(selected[0]);
  });

  it("applies the same lane contract to explicit and implicit selection", () => {
    const scenarios = [
      makeScenario("generic"),
      makeScenario("openai-only", {
        config: { requiredProvider: "openai", requiredModel: "gpt-5.6-luna" },
      }),
      makeScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-8" },
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "live-frontier" as const,
      primaryModel: "openai/gpt-5.6-luna",
    };

    const selectIds = (scenarioIds?: string[]) =>
      selectQaFlowSuiteScenarios({ ...lane, scenarioIds }).map((scenario) => scenario.id);
    expect(selectIds()).toEqual(["generic", "openai-only"]);
    expect(selectIds(["openai-only"])).toEqual(["openai-only"]);
    expect(() => selectIds(["anthropic-only"])).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic, model=claude-opus-4-8)",
    );
  });

  it("resolves driver channels from scenario execution with explicit and default fallbacks", () => {
    const plain = makeScenario("plain");
    const slack = makeScenario("slack-flow", { channel: "slack" });
    const telegram = makeScenario("telegram-flow", { channel: "telegram" });
    expect(resolveChannel([plain])).toBe("telegram");
    expect(resolveChannel([plain, slack])).toBe("slack");
    expect(resolveChannel([slack], "slack")).toBe("slack");
    expect(() => resolveChannel([slack], "telegram")).toThrow(
      "--channel telegram conflicts with selected scenario execution.channel slack.",
    );
    expect(() => resolveChannel([slack, telegram])).toThrow(
      "Selected QA scenarios require multiple channels",
    );
    expect(
      resolveQaSuiteScenarioChannels(
        channelParams([plain, makeScenario("matrix-flow", { channel: "matrix" }), slack]),
      ),
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

  it("isolates and collects scenario-declared transport policy", () => {
    const scenario = makeScenario("sender-policy", {
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
      makeScenario("generic", { plugins: ["active-memory", "memory-wiki"] }),
      makeScenario("other", { plugins: ["memory-wiki", "openai"] }),
      makeScenario("plain"),
    ];

    expect(collectQaSuitePluginIds(scenarios)).toEqual(["active-memory", "memory-wiki", "openai"]);
  });

  it("ignores prototype-mutating keys in scenario startup config patches", () => {
    const scenarios = [
      makeScenario("polluted", {
        gatewayConfigPatch: JSON.parse(
          `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
        ) as Record<string, unknown>,
      }),
    ];

    expect(applyPatches(scenarios)).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps a scenario deletion from resurrecting baseline siblings", () => {
    const scenarios = [
      makeScenario("drops-tools", { gatewayConfigPatch: { tools: null } }),
      makeScenario("adds-web-search", {
        gatewayConfigPatch: { tools: { web: { search: { enabled: true } } } },
      }),
    ];
    const baseline = { tools: { profile: "coding", deny: ["shell"] } };

    expect(applyPatches(scenarios, baseline)).toEqual({
      tools: { web: { search: { enabled: true } } },
    });
  });

  it("targets the selected adapter account in scenario startup config patches", () => {
    const accounts = { "whatsapp-alt": { dmPolicy: "open" } };
    expect(
      applyPatches([readQaScenarioById("whatsapp-access-control-dm-open")], {}, "whatsapp-alt"),
    ).toEqual({ channels: { whatsapp: { accounts } } });
  });

  it("collects gateway runtime options across selected scenarios", () => {
    const scenarios = [
      makeScenario("plain"),
      ...[
        { forwardHostHome: true },
        { preserveDebugArtifacts: true },
        { allowUnhealthyStartup: true },
      ].map((gatewayRuntime, index) => makeScenario(String(index), { gatewayRuntime })),
    ];

    expect(collectQaSuiteGatewayRuntimeOptions(scenarios)).toEqual({
      allowUnhealthyStartup: true,
      forwardHostHome: true,
      preserveDebugArtifacts: true,
    });
  });

  it.each([
    ["explicit scenario isolation", () => makeScenario("isolated", { suiteIsolation: "isolated" })],
    ["scenario-owned plugins", () => makeScenario("plugin", { plugins: ["diagnostics-otel"] })],
    ["state-mutating flow calls", () => readQaScenarioById("plugin-lifecycle-hot-reload")],
  ] as const)("isolates serial runs for %s", (_reason, createScenario) => {
    const scenario = createScenario();

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeScenario("baseline"), scenario],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("rejects explicit Playwright scenarios in the flow suite selector", () => {
    const scenarios: Scenario[] = [
      makeScenario("flow"),
      {
        ...makeScenario("playwright"),
        execution: { kind: "playwright", path: "ui/src/e2e/playwright.e2e.test.ts" },
      },
    ];

    expect(() => selectMock(scenarios, ["playwright"])).toThrow(
      "suite execution requires flow scenarios; unsupported scenario(s): playwright (playwright)",
    );
  });
});
