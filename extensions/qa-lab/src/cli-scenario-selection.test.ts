import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaProfileCommand, runQaSuiteCommand } = vi.hoisted(() => ({
  runQaProfileCommand: vi.fn(),
  runQaSuiteCommand: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions: () => [],
}));

// mock-isolation: Capture CLI routing without starting scenario runners or Gateways.
vi.mock("./cli.runtime.js", () => ({ runQaProfileCommand, runQaSuiteCommand }));

import { registerQaLabCli } from "./cli.js";
import type { QaSuiteCommandOptions } from "./cli.runtime.js";
import { resolveQaRunProfileMembership } from "./profile-planning.js";
import type { QaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe.each(["suite", "profile"] as const)("%s scenario selection", (lane) => {
  let program: Command;
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let selectedScenarioIds: string[];
  let excludedScenarioIds: string[];
  const runCommand = lane === "suite" ? runQaSuiteCommand : runQaProfileCommand;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program = new Command();
    runQaSuiteCommand.mockReset();
    runQaProfileCommand.mockReset();
    registerQaLabCli(program);
    selectedScenarioIds = [];
    excludedScenarioIds = [];
    const scenarios = ["selected-scenario", "unrequested-scenario"].map((id) =>
      makeQaSuiteTestScenario(id),
    );
    runCommand.mockImplementation(async (opts: QaSuiteCommandOptions & { profile?: string }) => {
      if (opts.providerMode !== "mock-openai" || !opts.primaryModel) {
        throw new Error("expected explicit fixture provider and model");
      }
      if (lane === "profile") {
        if (opts.profile !== "selection-profile") {
          throw new Error("expected explicit fixture profile");
        }
        const coverageIds = ["test.selection"];
        const scenarioRefs = scenarios.map((scenario) => scenario.sourcePath);
        const scorecardReport = {
          taxonomyPath: "taxonomy.yaml",
          title: "Selection fixture",
          taxonomy: null,
          profileCount: 1,
          profiles: [
            {
              id: "selection-profile",
              evidenceMode: "full",
              channelDriver: "qa-channel",
              categoryIds: coverageIds,
              coverageIds,
              scenarioRefs,
            },
          ],
          categoryCount: 1,
          requiredCategoryCount: 1,
          inventoriedCategoryCount: 1,
          categoryInventoryPercent: 100,
          requiredCoverageIdCount: 1,
          inventoriedCoverageIdCount: 1,
          coverageIdInventoryPercent: 100,
          inventoryRefCount: 0,
          scenarioCoverageIdCount: 1,
          unknownCoverageIdCount: 0,
          unknownCoverageIds: [],
          validationIssueCount: 0,
          validationIssues: [],
          categories: [
            {
              id: "test.selection",
              taxonomySurfaceId: "test",
              taxonomyCategoryName: "selection",
              inventoryStatus: "complete",
              profiles: ["selection-profile"],
              features: [],
              coverageIds,
              inventoriedCoverageIds: coverageIds,
              inventoryRefs: [],
              scenarioRefs,
              missingCoverageIds: [],
              missingInventoryRefs: [],
            },
          ],
        } satisfies QaScorecardTaxonomyReport;
        const membership = resolveQaRunProfileMembership(
          { profile: opts.profile, scenarioIds: opts.scenarioIds },
          { scenarios, scorecardReport },
        );
        selectedScenarioIds = membership.selectedScenarios.map((scenario) => scenario.id);
        excludedScenarioIds = membership.excludedScenarioIds;
        return;
      }
      selectedScenarioIds = selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: opts.scenarioIds,
        providerMode: opts.providerMode,
        primaryModel: opts.primaryModel,
      }).map((scenario) => scenario.id);
    });
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
  });

  const suiteArgs = ["node", "openclaw", "qa"].concat(
    lane === "suite" ? ["suite"] : ["run", "--qa-profile", "selection-profile"],
    ["--provider-mode", "mock-openai", "--model", "mock-openai/gpt-5.6-luna"],
  );
  const parse = (args: string[]) => program.parseAsync([...suiteArgs, ...args]);
  const expectError = (message: string) => {
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(process.exitCode).toBe(1);
  };

  it.each([
    ["empty value", ""],
    ["whitespace value", " \t "],
  ])("rejects an explicit all-blank selection: %s", async (_name, value) => {
    await parse(["--scenario", value]);
    expectError("--scenario must name at least one non-empty scenario id.");
    expect(selectedScenarioIds).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    [[], ["selected-scenario", "unrequested-scenario"]],
    [[" selected-scenario "], ["selected-scenario"]],
    [["", "selected-scenario", "  "], ["selected-scenario"]],
  ] satisfies [string[], string[]][])("preserves selection %j", async (values, expected) => {
    await parse(values.flatMap((value) => ["--scenario", value]));
    expect(runCommand).toHaveBeenCalledOnce();
    expect(selectedScenarioIds).toEqual(expected);
  });

  it("keeps unknown non-empty ids out of the selection", async () => {
    await parse(["--scenario", "unknown-scenario"]);
    if (lane === "suite") {
      expectError("unknown QA scenario id(s): unknown-scenario");
    } else {
      expect(excludedScenarioIds).toEqual(["unknown-scenario"]);
    }
    expect(runCommand).toHaveBeenCalledOnce();
    expect(selectedScenarioIds).toEqual([]);
  });

  it("keeps missing option values rejected by Commander before dispatch", async () => {
    const suite = program.commands
      .find((command) => command.name() === "qa")
      ?.commands.find((command) => command.name() === (lane === "suite" ? "suite" : "run"));
    if (!suite) {
      throw new Error("expected QA scenario command");
    }
    suite.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(parse(["--scenario"])).rejects.toThrow("--scenario");
    expect(runCommand).not.toHaveBeenCalled();
    expect(selectedScenarioIds).toEqual([]);
  });
});
