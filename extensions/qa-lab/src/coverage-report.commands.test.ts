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

function reportedCommand(scenario: QaSeedScenarioWithSource) {
  const matches = findQaScenarioMatches([scenario], scenario.id);
  const report = renderQaScenarioMatchesMarkdownReport({ query: "selected scenarios", matches });
  return expectDefined(report.match(/(?<=`)pnpm openclaw qa suite[^`]+(?=`)/u)?.[0], "command");
}

describe("QA coverage command selection", () => {
  it.each([
    ["telegram-assistant-transcript-role-boundary", "crabline"],
    ["matrix-room-generated-image-delivery", "live"],
    ["remember-across-conversations", "qa-channel"],
    ["whatsapp-access-control-group-disabled", "live"],
    ["agent-startup-instruction-first-action", "qa-channel"],
    ["channel-canary", "qa-channel"],
    [
      makeQaSuiteTestScenario("driver-only", { config: { requiredChannelDriver: "crabline" } }),
      "crabline",
    ],
  ] as const)("selects exactly %s from its generated command", (input, driver) => {
    const scenario = typeof input === "string" ? readQaScenarioById(input) : input;
    const argv = captureReportedArgv(reportedCommand(scenario));
    expect(argv.slice(0, suiteArgv.length)).toEqual(suiteArgv);
    let suite = new Command();
    registerQaLabCli(suite);
    for (const name of ["qa", "suite"]) {
      suite = expectDefined(
        suite.commands.find((entry) => entry.name() === name),
        name,
      );
    }
    expect(suite.parseOptions(argv.slice(suiteArgv.length))).toEqual({ operands: [], unknown: [] });
    const opts = suite.opts<SuiteFilters & { scenario: string[] }>();
    const providerMode = opts.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE;
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        ...opts,
        scenarioIds: opts.scenario,
        providerMode,
        primaryModel: defaultQaModelForMode(providerMode),
      }).map(({ id }) => id),
    ).toEqual([scenario.id]);
    expect(opts.scenario).toEqual([scenario.id]);
    expect(opts.channelDriver ?? "qa-channel").toBe(driver);
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
    expect(captureReportedArgv(reportedCommand(scenario))).toEqual([
      ...suiteArgv,
      "--channel-driver",
      requiredChannelDriver,
      "--scenario",
      scenario.id,
    ]);
  });
});
