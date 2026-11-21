import { execFileSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerQaLabCli } from "./cli.js";
import { findQaScenarioMatches, renderQaScenarioMatchesMarkdownReport } from "./coverage-report.js";
import { defaultQaModelForMode } from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { readQaScenarioById, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

const suiteArgv = ["pnpm", "openclaw", "qa", "suite"];
type SuiteSelection = Parameters<typeof selectQaFlowSuiteScenarios>[0];
type SuiteFilters = Partial<Pick<SuiteSelection, "providerMode" | "channel" | "channelDriver">>;

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions: () => [],
}));

function captureReportedArgv(command: string): string[] {
  // Previews use POSIX quoting; Windows test hosts need Git Bash's sh on PATH.
  // Capture the shell-expanded arguments without starting pnpm or a QA provider.
  const argv = execFileSync("sh", ["-c", `pnpm() { printf '%s\\0' pnpm "$@"; }\n${command}`], {
    encoding: "utf8",
    timeout: 5_000,
  }).split("\0");
  expect(argv.pop()).toBe("");
  return argv;
}

function reportedCommands(scenarios: QaSeedScenarioWithSource[]) {
  const matches = scenarios.flatMap((scenario) => findQaScenarioMatches([scenario], scenario.id));
  const report = renderQaScenarioMatchesMarkdownReport({ query: "selected scenarios", matches });
  const commands = report.match(/(?<=`)pnpm openclaw qa suite[^`]+(?=`)/gu) ?? [];
  expect(commands.length).toBeGreaterThan(0);
  return commands;
}

function selectReportedCommands(scenarios: QaSeedScenarioWithSource[]) {
  return reportedCommands(scenarios).map((command) => {
    const argv = captureReportedArgv(command);
    expect(argv.slice(0, suiteArgv.length)).toEqual(suiteArgv);
    let suite = new Command();
    registerQaLabCli(suite);
    for (const name of ["qa", "suite"]) {
      suite = expectDefined(
        suite.commands.find((entry) => entry.name() === name),
        name,
      );
    }
    // Parse the real options without running the suite action or starting a provider.
    expect(suite.parseOptions(argv.slice(suiteArgv.length))).toEqual({ operands: [], unknown: [] });
    const opts = suite.opts<SuiteFilters & { scenario: string[] }>();
    expect(opts.scenario.length).toBeGreaterThan(0);
    const providerMode = opts.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE;
    const selected = selectQaFlowSuiteScenarios({
      scenarios,
      ...opts,
      scenarioIds: opts.scenario,
      providerMode,
      primaryModel: defaultQaModelForMode(providerMode),
    });
    const ids = selected.map(({ id }) => id);
    expect(ids, command).toEqual(opts.scenario);
    return { driver: opts.channelDriver ?? "qa-channel", ids };
  });
}

describe("QA coverage command selection", () => {
  it.each([
    ["telegram-assistant-transcript-role-boundary", "crabline"],
    ["matrix-room-generated-image-delivery", "live"],
    ["remember-across-conversations", "qa-channel"],
    ["whatsapp-access-control-group-disabled", "live"],
    ["instruction-followthrough-repo-contract", "qa-channel"],
    ["agent-startup-instruction-first-action", "qa-channel"],
    ["channel-canary", "qa-channel"],
    [
      makeQaSuiteTestScenario("driver-only", { config: { requiredChannelDriver: "crabline" } }),
      "crabline",
    ],
  ] as const)("selects exactly %s from its generated command", (input, driver) => {
    const scenario = typeof input === "string" ? readQaScenarioById(input) : input;
    expect(selectReportedCommands([scenario])).toEqual([{ driver, ids: [scenario.id] }]);
  });

  it("separates conflicting drivers on the same channel and groups compatible scenarios", () => {
    const scenarios = [
      ...["crabline", "live"].flatMap((requiredChannelDriver) =>
        ["first", "second"].map((suffix) =>
          makeQaSuiteTestScenario(`${requiredChannelDriver}-${suffix}`, {
            channel: "telegram",
            config: { requiredChannelDriver, requiredProviderMode: "mock-openai" },
          }),
        ),
      ),
      makeQaSuiteTestScenario("unconstrained", { channel: "telegram" }),
    ];

    expect(selectReportedCommands(scenarios)).toEqual([
      { driver: "crabline", ids: ["crabline-first", "crabline-second"] },
      { driver: "live", ids: ["live-first", "live-second"] },
      { driver: "live", ids: ["unconstrained"] },
    ]);
  });

  it("keeps a declared driver as one shell argument", () => {
    const requiredChannelDriver = "crabline' ; printf unexpected #";
    const scenario = makeQaSuiteTestScenario("quoted-driver", {
      config: { requiredChannelDriver },
    });
    const command = expectDefined(reportedCommands([scenario])[0], "command");

    expect(captureReportedArgv(command)).toEqual([
      ...suiteArgv,
      "--channel-driver",
      requiredChannelDriver,
      "--scenario",
      scenario.id,
    ]);
  });
});
