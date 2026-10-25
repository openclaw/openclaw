import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  collectQaSuiteTransportPolicy,
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  scenarioRequiresIsolatedQaSuiteWorker,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
} from "./suite-planning.js";
import { makeQaSuiteTestScenario as makeScenario } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir: makeRoot, cleanup } = createTempDirHarness();
afterEach(cleanup);

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
  });

  it("resolves driver channels from scenario execution with explicit and default fallbacks", () => {
    const plain = makeScenario("plain", { channel: "   " });
    const slack = makeScenario("slack-flow", { channel: " Slack " });
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
    for (const id of [
      "matrix-reaction-notification",
      "matrix-reaction-threaded",
      "matrix-reaction-not-a-reply",
      "matrix-reaction-redaction-observed",
    ]) {
      const scenario = readQaScenarioById(id);
      expect(scenario.execution, id).toMatchObject({
        suiteIsolation: "isolated",
        isolationReason: expect.stringContaining("fresh canary reply"),
      });
      expect(scenarioRequiresIsolatedQaSuiteWorker(scenario), id).toBe(true);
    }
  });

  it("isolates and collects scenario-declared transport policy", () => {
    const transportPolicy = {
      directMessageOnly: true as const,
      requireGroupMention: true as const,
      senderAllowlist: ["driver"],
    };
    const scenario = makeScenario("sender-policy", { transportPolicy });

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(collectQaSuiteTransportPolicy([scenario])).toEqual(transportPolicy);
  });

  it("collects unique scenario-declared bundled plugins in encounter order", () => {
    const scenarios = [
      makeScenario("generic", { plugins: ["active-memory", "memory-wiki"] }),
      makeScenario("other", { plugins: ["memory-wiki", "openai"] }),
      makeScenario("plain"),
    ];

    expect(collectQaSuitePluginIds(scenarios)).toEqual(["active-memory", "memory-wiki", "openai"]);
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
