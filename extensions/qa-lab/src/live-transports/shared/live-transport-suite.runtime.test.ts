import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());
const loadMatrixQaE2eeRuntime = vi.hoisted(() => vi.fn());
const resolveLiveTransportQaScenarioIds = vi.hoisted(() => vi.fn());
const runFlowWorkers = vi.hoisted(() =>
  vi.fn<typeof import("../../suite-run-standard.js").runQaFlowSuiteStandard>(),
);

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));
vi.mock("../matrix/substrate/e2ee-client.js", () => ({ loadMatrixQaE2eeRuntime }));
vi.mock("../../suite-run-standard.js", () => ({ runQaFlowSuiteStandard: runFlowWorkers }));
vi.mock("../../suite-run-isolated.js", () => ({ runQaFlowSuiteIsolated: runFlowWorkers }));
vi.mock("./scenario-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-selection.js")>()),
  resolveLiveTransportQaScenarioIds,
}));

import type { QaSeedScenarioWithSource } from "../../scenario-catalog.js";
import { runQaSuite } from "../../suite-launch.runtime.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";
import type { QaSuiteRunParams } from "../../suite.js";
import { discordQaCliRegistration } from "../discord/cli.js";
import { matrixQaCliRegistration } from "../matrix/cli.js";
import {
  runLiveTransportQaSuiteCommand,
  runStandardLiveTransportQaSuiteCommand,
} from "./live-transport-suite.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parseQa(channel: "discord" | "matrix", ...args: string[]) {
  const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  const registration = channel === "matrix" ? matrixQaCliRegistration : discordQaCliRegistration;
  registration.register(qa);
  return qa.parseAsync(["node", "openclaw", channel, ...args]);
}

function expectDispatch(fields: Record<string, unknown>) {
  expect(runQaSuiteCommand).toHaveBeenLastCalledWith(expect.objectContaining(fields));
}

function runLiveCommand(
  options: Parameters<typeof runLiveTransportQaSuiteCommand>[0]["options"],
  overrides: Partial<Parameters<typeof runLiveTransportQaSuiteCommand>[0]> = {},
) {
  return runLiveTransportQaSuiteCommand({
    channelId: "discord",
    defaultProviderMode: "live-frontier",
    selectScenarioIds: () => ["discord-canary"],
    ...overrides,
    options,
  });
}

type CommandOptions = Parameters<typeof runLiveCommand>[0];
const runDiscord = (options: CommandOptions) =>
  runStandardLiveTransportQaSuiteCommand({ channelId: "discord", options });
const parseDiscord = (...args: string[]) => parseQa("discord", ...args);
const doctorStep = { name: "native readiness", actions: [{ call: "channelE2e.doctor" }] };
const recipeConfig = { agentE2e: true, marker: "external-recipe" };

async function writeAgentE2eRecipe(
  directory: string,
  id: string,
  execution: Record<string, unknown> = {},
  includeFlow = true,
) {
  const file = path.join(directory, `${id}.yaml`);
  await fs.writeFile(
    file,
    JSON.stringify({
      title: `External ${id}`,
      scenario: {
        id,
        surface: "channels",
        objective: "Exercise only this selected native flow.",
        successCriteria: ["The selected flow completes."],
        execution: {
          kind: "flow",
          channel: "discord",
          timeoutMs: 23456,
          config: recipeConfig,
          ...execution,
        },
      },
      ...(includeFlow ? { flow: { steps: [doctorStep] } } : {}),
    }),
  );
  return file;
}

describe("live transport suite runtime", () => {
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  async function expectQaFailure(args: string[], message: string | RegExp) {
    await parseDiscord(...args);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(process.exitCode).toBe(1);
  }
  async function rejectBeforeDispatch(args: string[], message: string | RegExp) {
    await expectQaFailure(args, message);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", "");
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_ROLE", "");
    vi.clearAllMocks();
    runQaSuiteCommand.mockReset();
    loadMatrixQaE2eeRuntime.mockReset();
    resolveLiveTransportQaScenarioIds.mockReset();
    runFlowWorkers.mockReset();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([undefined, 2])("parses Matrix concurrency %s", async (concurrency) => {
    await parseQa(
      "matrix",
      "--provider-mode",
      "mock-openai",
      "--scenario",
      "matrix-allowlist-hot-reload",
      ...(concurrency === undefined ? [] : ["--concurrency", String(concurrency)]),
    );

    expectDispatch({ channel: "matrix", ...(concurrency === undefined ? {} : { concurrency }) });
    if (concurrency === undefined) {
      expect(runQaSuiteCommand.mock.calls[0]?.[0]).not.toHaveProperty("concurrency");
    }
  });

  it.each([
    ["dedicated", "ready"],
    ["dedicated", "failed"],
    ["default selection", "ready"],
    ["plain selection", "ready"],
  ] as const)("prepares %s Matrix flows before workers start (%s)", async (caller, outcome) => {
    const outputDir = tempDirs.make("matrix-suite-preparation-");
    const initialization = createDeferred<void>();
    const entered = createDeferred<"initialization" | "workers">();
    const failure = new Error("crypto initialization failed");
    const workerBoundary = new Error("reached prepared workers");
    const priorArtifacts = ["qa-suite-summary.json", "qa-evidence.json", "qa-suite-report.md"];
    if (outcome === "failed") {
      await fs.mkdir(path.join(outputDir, "proof"));
      await Promise.all(
        priorArtifacts.map((name) =>
          fs.writeFile(path.join(outputDir, "proof", name), "prior successful generation"),
        ),
      );
    }
    loadMatrixQaE2eeRuntime.mockImplementation(() => {
      entered.resolve("initialization");
      return initialization.promise;
    });
    runFlowWorkers.mockImplementation(async () => {
      entered.resolve("workers");
      throw workerBoundary;
    });
    const scenarioIds = [
      "matrix-allowbots-default-block",
      "matrix-e2ee-cli-account-add-enable-e2ee",
    ];
    const params: QaSuiteRunParams = {
      repoRoot: outputDir,
      outputDir: path.join(outputDir, "proof"),
      providerMode: "mock-openai",
      channelDriver: "live",
      channelId: "matrix",
      adapterFactories: [matrixQaCliRegistration.adapterFactory!],
      concurrency: 4,
      scenarioIds:
        caller === "default selection"
          ? undefined
          : caller === "plain selection"
            ? ["matrix-allowbots-default-block"]
            : scenarioIds,
    };
    runQaSuiteCommand.mockImplementation((options) =>
      runQaSuite({ ...params, scenarioIds: options.scenarioIds }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Matrix CLI must not force process exit");
    });
    const run =
      caller === "dedicated"
        ? parseQa(
            "matrix",
            "--provider-mode",
            "mock-openai",
            ...scenarioIds.flatMap((id) => ["--scenario", id]),
          )
        : runQaSuite(params);
    const settled = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const first = await Promise.race([entered.promise, settled.then(() => "settled")]);
      expect(first).toBe(caller === "plain selection" ? "workers" : "initialization");
      if (caller === "plain selection") {
        expect(loadMatrixQaE2eeRuntime).not.toHaveBeenCalled();
      } else {
        expect(runFlowWorkers).not.toHaveBeenCalled();
        if (outcome === "failed") {
          initialization.reject(failure);
        } else {
          initialization.resolve();
        }
      }
      expect(await settled).toBe(caller === "dedicated" ? undefined : workerBoundary);
      if (outcome === "failed") {
        expect(stderrWrite).toHaveBeenCalledExactlyOnceWith(`${failure.message}\n`);
        expect(process.exitCode).toBe(1);
        expect(exit).not.toHaveBeenCalled();
        expect(runFlowWorkers).not.toHaveBeenCalled();
        for (const name of priorArtifacts) {
          await expect(fs.stat(path.join(outputDir, "proof", name))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } else {
        expect(runFlowWorkers).toHaveBeenCalled();
      }
    } finally {
      initialization.resolve();
      await settled;
    }
  });

  it("rejects invalid dedicated Matrix concurrency before suite dispatch", async () => {
    await expect(parseQa("matrix", "--concurrency", "1.5")).rejects.toThrow(
      "--concurrency must be a positive integer.",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("normalizes credentials and selects the default live lane", async () => {
    await runLiveCommand({ credentialSource: " convex ", credentialRole: " ci " });
    expectDispatch({
      providerMode: "live-frontier",
      channelDriver: "live",
      scenarioIds: ["discord-canary"],
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("propagates selection context through the standard suite owner", async () => {
    resolveLiveTransportQaScenarioIds.mockReturnValueOnce(["discord-canary"]);
    await runDiscord({ scenarioIds: ["discord-canary"] });
    expectDispatch({
      channel: "discord",
      scenarioIds: ["discord-canary"],
      explicitScenarioSelection: true,
    });
  });

  it("routes dedicated Discord through Crabline without channel credential inputs", async () => {
    await runDiscord({
      channelDriver: "crabline",
      providerMode: "mock-openai",
      scenarioIds: ["discord-crabline-roundtrip"],
    });

    expectDispatch({
      channel: "discord",
      channelDriver: "crabline",
      scenarioIds: ["discord-crabline-roundtrip"],
    });
    expect(runQaSuiteCommand.mock.calls.at(-1)?.[0]).not.toHaveProperty("credentialFile");

    for (const options of [
      { credentialFile: "/tmp/not-used.json" },
      { credentialSource: "env" },
      { credentialRole: "ci" },
    ]) {
      await expect(runDiscord({ channelDriver: "crabline", ...options })).rejects.toThrow(
        /Crabline channel drivers do not use/u,
      );
    }
  });

  it("keeps voice scenarios on the live Discord transport", async () => {
    await expect(
      runDiscord({
        channelDriver: "crabline",
        providerMode: "mock-openai",
        scenarioIds: ["discord-voice-autojoin"],
      }),
    ).rejects.toThrow(/channelDriver=live/u);
  });

  it("normalizes the shared credential source environment override", async () => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", " convex ");

    await runLiveCommand({});
    expectDispatch({ credentialSource: "convex" });
  });

  it("rejects shared credentials for disposable transports", async () => {
    const matrix = {
      channelId: "matrix",
      credentialMode: "env-only" as const,
      laneLabel: "Matrix",
      selectScenarioIds: () => ["channel-chat-baseline"],
    };
    await expect(
      runLiveCommand(
        { credentialSource: "convex" },
        {
          ...matrix,
          envCredentialReason: "its homeserver is disposable and local.",
        },
      ),
    ).rejects.toThrow(
      "QA Lab Matrix supports only --credential-source env because its homeserver is disposable and local.",
    );
    await expect(runLiveCommand({ credentialRole: "ci" }, matrix)).rejects.toThrow(
      "QA Lab Matrix does not use credential roles.",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it.each([
    [[], "mock-openai", "convex", "ci"],
    [
      [
        "--provider-mode",
        "live-frontier",
        "--credential-source",
        "env",
        "--credential-role",
        "maintainer",
      ],
      "live-frontier",
      "env",
      "maintainer",
    ],
  ] as const)(
    "selects only the doctor with overrides %j",
    async (args, providerMode, credentialSource, credentialRole) => {
      await parseDiscord("--doctor", ...args);
      expectDispatch({
        providerMode,
        credentialSource,
        credentialRole,
        explicitScenarioSelection: true,
        scenarioIds: ["discord-e2e-doctor"],
        scenarioDefinitions: [expect.objectContaining({ id: "discord-e2e-doctor" })],
      });
      expect(resolveLiveTransportQaScenarioIds).not.toHaveBeenCalled();
    },
  );

  it("lists only the repeated file selections without dispatching or injecting the curated suite", async () => {
    const directory = tempDirs.make("agent-e2e-selection-");
    const first = await writeAgentE2eRecipe(directory, "first-external");
    const second = await writeAgentE2eRecipe(directory, "second-external");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseDiscord("--scenario-file", first, "--scenario-file", second, "--list-scenarios");
    expect(output.mock.calls.map(([text]) => text).join("")).toBe(
      "first-external\nsecond-external\n",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
    expect(resolveLiveTransportQaScenarioIds).not.toHaveBeenCalled();
  });

  it("runs the external definition rather than a catalog flow with the same id", async () => {
    const directory = tempDirs.make("agent-e2e-external-flow-");
    const file = await writeAgentE2eRecipe(directory, "discord-e2e-doctor");
    let selected: QaSeedScenarioWithSource[] = [];
    const boundary = new Error("reached selected workers without acquiring credentials");
    runFlowWorkers.mockImplementation((_params, context) => {
      selected = context.selectedScenarios;
      throw boundary;
    });
    runQaSuiteCommand.mockImplementation((options) =>
      runQaSuite({
        repoRoot: directory,
        outputDir: path.join(directory, "proof"),
        providerMode: options.providerMode,
        channelDriver: "live",
        channelId: "discord",
        scenarioIds: options.scenarioIds,
        scenarioDefinitions: options.scenarioDefinitions,
        adapterFactories: [discordQaCliRegistration.adapterFactory!],
      }),
    );
    await expectQaFailure(["--scenario-file", file], boundary.message);
    expect(selected).toMatchObject([
      {
        sourcePath: file,
        execution: {
          timeoutMs: 23456,
          retryCount: 0,
          config: recipeConfig,
          flow: { steps: [doctorStep] },
        },
      },
    ]);
    const ordinary = {
      ...selected[0]!,
      id: "ordinary",
      execution: { ...selected[0]!.execution, config: {} },
    };
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [...selected, ordinary],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/fixture",
        channelDriver: "live",
        channel: "discord",
      }).map((scenario) => scenario.id),
    ).toEqual(["ordinary"]);
  });

  it.each([
    {
      name: "wrong channel",
      execution: { channel: "slack" },
      expected: /must declare channel discord/u,
    },
    { name: "missing flow", includeFlow: false, expected: /top-level flow block/u },
    { name: "missing file", missing: true, expected: /ENOENT/u },
    { name: "missing opt-in", execution: { config: {} }, expected: /execution.config.agentE2e/u },
    { name: "retrying writes", execution: { retryCount: 1 }, expected: /retryCount: 0/u },
    {
      name: "provider mismatch",
      execution: { config: { agentE2e: true, requiredProviderMode: "live-frontier" } },
      expected: /providerMode=live-frontier/u,
    },
  ])("rejects $name before credential-bearing suite dispatch", async (fixture) => {
    const directory = tempDirs.make("agent-e2e-invalid-");
    const file = fixture.missing
      ? path.join(directory, "missing.yaml")
      : await writeAgentE2eRecipe(directory, "invalid", fixture.execution, fixture.includeFlow);
    await rejectBeforeDispatch(["--scenario-file", file], fixture.expected);
  });

  it.each([
    { args: ["--doctor", "--scenario-file", "unused.yaml"], expected: /cannot be combined/u },
    {
      args: ["--scenario-file", "unused.yaml", "--scenario", "discord-canary"],
      expected: /cannot be combined/u,
    },
    {
      args: ["--doctor", "--channel-driver", "crabline"],
      expected: /require the live channel driver/u,
    },
  ])("rejects conflicting or empty explicit selection: $args", async ({ args, expected }) => {
    await rejectBeforeDispatch(args, expected);
  });

  it("rejects colliding file scenario ids instead of silently replacing a flow", async () => {
    const firstDir = tempDirs.make("agent-e2e-first-");
    const secondDir = tempDirs.make("agent-e2e-second-");
    const first = await writeAgentE2eRecipe(firstDir, "collision");
    const second = await writeAgentE2eRecipe(secondDir, "collision", { timeoutMs: 9999 });
    await rejectBeforeDispatch(
      ["--scenario-file", first, "--scenario-file", second],
      /duplicate QA scenario id/u,
    );
  });

  it("rejects an empty scenario file in the argument parser before dispatch", async () => {
    await expect(parseDiscord("--scenario-file", " ")).rejects.toThrow(/non-empty YAML file path/u);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(runLiveCommand({ providerMode: "unknown" })).rejects.toThrow(
      "unknown QA provider mode: unknown",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
