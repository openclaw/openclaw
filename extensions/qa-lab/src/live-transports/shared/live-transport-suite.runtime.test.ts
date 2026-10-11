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
import { recordQaSuiteTestResults } from "../../suite-test-helpers.js";
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
          config: { agentE2e: true, marker: "external-recipe" },
          ...execution,
        },
      },
      ...(includeFlow
        ? {
            flow: {
              steps: [{ name: "native readiness", actions: [{ call: "channelE2e.doctor" }] }],
            },
          }
        : {}),
    }),
  );
  return file;
}

describe("live transport suite runtime", () => {
  let previousExitCode: typeof process.exitCode;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  async function expectQaFailure(args: string[], message: string | RegExp) {
    await parseQa("discord", ...args);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(process.exitCode).toBe(1);
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

  it.each([undefined, 2])(
    "forwards the dedicated Matrix concurrency %s through parsing and the live suite host",
    async (concurrency) => {
      await parseQa(
        "matrix",
        "--provider-mode",
        "mock-openai",
        "--scenario",
        "matrix-allowlist-hot-reload",
        ...(concurrency === undefined ? [] : ["--concurrency", String(concurrency)]),
      );

      expect(runQaSuiteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          channelDriver: "live",
          channel: "matrix",
          scenarioIds: ["matrix-allowlist-hot-reload"],
          ...(concurrency === undefined ? {} : { concurrency }),
        }),
      );
      if (concurrency === undefined) {
        expect(runQaSuiteCommand.mock.calls[0]?.[0]).not.toHaveProperty("concurrency");
      }
    },
  );

  it.each([
    ["dedicated", "ready"],
    ["dedicated", "failed"],
    ["default selection", "ready"],
    ["plain selection", "ready"],
  ] as const)("prepares %s Matrix flows before workers start (%s)", async (caller, outcome) => {
    const outputDir = tempDirs.make("matrix-suite-preparation-");
    const initialization = createDeferred<void>();
    const initializationStarted = createDeferred<void>();
    const workersStarted = createDeferred<void>();
    const failure = new Error("crypto initialization failed");
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
      initializationStarted.resolve();
      return initialization.promise;
    });
    runFlowWorkers.mockImplementation(async (params, context) => {
      workersStarted.resolve();
      const scenarioIds = context.selectedScenarios.map((scenario) => scenario.id);
      return {
        ...recordQaSuiteTestResults(
          params,
          context.selectedScenarios,
          scenarioIds.map((name) => ({ name, status: "pass", steps: [] })),
        ),
        outputDir: context.outputDir,
        evidencePath: path.join(context.outputDir, "qa-evidence.json"),
        reportPath: path.join(context.outputDir, "qa-suite-report.md"),
        summaryPath: path.join(context.outputDir, "qa-suite-summary.json"),
        report: "# QA Suite Report\n",
        startedScenarioIds: scenarioIds,
        watchUrl: "http://127.0.0.1:43124",
      };
    });
    const scenarioIds = [
      "matrix-allowbots-default-block",
      "matrix-e2ee-cli-account-add-enable-e2ee",
      "matrix-approval-channel-target-both",
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
    let suite: ReturnType<typeof runQaSuite> | undefined;
    runQaSuiteCommand.mockImplementation((options) => {
      suite = runQaSuite({ ...params, scenarioIds: options.scenarioIds });
      return suite;
    });
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
      const first = await Promise.race([
        initializationStarted.promise.then(() => "initialization"),
        workersStarted.promise.then(() => "workers"),
        settled.then((error) => {
          if (error instanceof Error) {
            throw error;
          }
          expect(error).toBeUndefined();
          return "settled";
        }),
      ]);
      if (caller === "plain selection") {
        expect(first).toBe("workers");
        expect(await settled).toBeUndefined();
        expect(loadMatrixQaE2eeRuntime).not.toHaveBeenCalled();
      } else {
        expect(first).toBe("initialization");
        expect(runFlowWorkers).not.toHaveBeenCalled();
        if (outcome === "failed") {
          initialization.reject(failure);
          if (caller === "dedicated") {
            expect(suite).toBeDefined();
            await expect(suite).rejects.toBe(failure);
            expect(await settled).toBeUndefined();
            expect(stderrWrite).toHaveBeenCalledExactlyOnceWith(`${failure.message}\n`);
            expect(process.exitCode).toBe(1);
            expect(exit).not.toHaveBeenCalled();
          } else {
            expect(await settled).toBe(failure);
          }
          expect(runFlowWorkers).not.toHaveBeenCalled();
          for (const name of priorArtifacts) {
            await expect(fs.stat(path.join(outputDir, "proof", name))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } else {
          initialization.resolve();
          expect(await settled).toBeUndefined();
          expect(runFlowWorkers).toHaveBeenCalled();
          expect(loadMatrixQaE2eeRuntime).toHaveBeenCalledOnce();
        }
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

  it("normalizes one live command into the shared suite host", async () => {
    const options = {
      repoRoot: "/repo",
      outputDir: ".artifacts/slack",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      credentialFile: "/secure/slack-qa.json",
      credentialSource: " convex ",
      credentialRole: " ci ",
      sutAccountId: "slack-sut",
    };
    await runLiveTransportQaSuiteCommand({
      channelId: "slack",
      defaultProviderMode: "live-frontier",
      options: { ...options },
      selectScenarioIds: ({ primaryModel, providerMode, scenarioIds }) => {
        expect(primaryModel).toBe("openai/gpt-5.5");
        expect(providerMode).toBe("live-frontier");
        expect(scenarioIds).toBeUndefined();
        return ["slack-canary"];
      },
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      ...options,
      providerMode: "live-frontier",
      channelDriver: "live",
      channel: "slack",
      scenarioIds: ["slack-canary"],
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("propagates selection context through the standard suite owner", async () => {
    const channelId = "discord";
    const scenarioId = "discord-canary";
    resolveLiveTransportQaScenarioIds.mockReturnValueOnce([scenarioId]);

    await runStandardLiveTransportQaSuiteCommand({
      channelId,
      options: {
        primaryModel: "openai/custom-selection-model",
        profile: "all",
        providerMode: "mock-openai",
        scenarioIds: [scenarioId, scenarioId],
      },
    });

    expect(resolveLiveTransportQaScenarioIds).toHaveBeenLastCalledWith({
      channelId,
      primaryModel: "openai/custom-selection-model",
      profile: "all",
      providerMode: "mock-openai",
      scenarioIds: [scenarioId, scenarioId],
      supportsModuleFlows: true,
    });
    expect(runQaSuiteCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: channelId,
        primaryModel: "openai/custom-selection-model",
        providerMode: "mock-openai",
        scenarioIds: [scenarioId],
        explicitScenarioSelection: true,
      }),
    );
  });

  it("routes dedicated Discord through Crabline without channel credential inputs", async () => {
    await runStandardLiveTransportQaSuiteCommand({
      channelId: "discord",
      options: {
        channelDriver: "crabline",
        providerMode: "mock-openai",
        scenarioIds: ["discord-crabline-roundtrip"],
      },
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        channelDriver: "crabline",
        scenarioIds: ["discord-crabline-roundtrip"],
      }),
    );
    expect(runQaSuiteCommand.mock.calls.at(-1)?.[0]).not.toHaveProperty("credentialFile");

    for (const options of [
      { credentialFile: "/tmp/not-used.json" },
      { credentialSource: "env" },
      { credentialRole: "ci" },
    ]) {
      await expect(
        runStandardLiveTransportQaSuiteCommand({
          channelId: "discord",
          options: { channelDriver: "crabline", ...options },
        }),
      ).rejects.toThrow(/Crabline channel drivers do not use/u);
    }
  });

  it("keeps voice scenarios on the live Discord transport", async () => {
    await expect(
      runStandardLiveTransportQaSuiteCommand({
        channelId: "discord",
        options: {
          channelDriver: "crabline",
          providerMode: "mock-openai",
          scenarioIds: ["discord-voice-autojoin"],
        },
      }),
    ).rejects.toThrow(/channelDriver=live/u);
  });

  it("normalizes the shared credential source environment override", async () => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", " convex ");

    await runLiveTransportQaSuiteCommand({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options: {},
      selectScenarioIds: () => ["channel-canary"],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "convex" }),
    );
  });

  it("rejects shared credentials for disposable transports", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        envCredentialReason: "its homeserver is disposable and local.",
        laneLabel: "Matrix",
        options: { credentialSource: "convex" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow(
      "QA Lab Matrix supports only --credential-source env because its homeserver is disposable and local.",
    );
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        laneLabel: "Matrix",
        options: { credentialRole: "ci" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("QA Lab Matrix does not use credential roles.");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("selects only the Discord doctor and respects explicit lane overrides", async () => {
    await parseQa("discord", "--doctor");
    expect(runQaSuiteCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerMode: "mock-openai",
        credentialSource: "convex",
        credentialRole: "ci",
        explicitScenarioSelection: true,
        scenarioIds: ["discord-e2e-doctor"],
        scenarioDefinitions: [expect.objectContaining({ id: "discord-e2e-doctor" })],
      }),
    );

    await parseQa(
      "discord",
      "--doctor",
      "--provider-mode",
      "live-frontier",
      "--credential-source",
      "env",
      "--credential-role",
      "maintainer",
    );
    expect(runQaSuiteCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerMode: "live-frontier",
        credentialSource: "env",
        credentialRole: "maintainer",
        scenarioIds: ["discord-e2e-doctor"],
      }),
    );
    expect(resolveLiveTransportQaScenarioIds).not.toHaveBeenCalled();
  });

  it("lists only the repeated file selections without dispatching or injecting the curated suite", async () => {
    const directory = tempDirs.make("agent-e2e-selection-");
    const first = await writeAgentE2eRecipe(directory, "first-external");
    const second = await writeAgentE2eRecipe(directory, "second-external");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await parseQa(
        "discord",
        "--scenario-file",
        first,
        "--scenario-file",
        second,
        "--list-scenarios",
      );
      expect(output.mock.calls.map(([text]) => text).join("")).toBe(
        "first-external\nsecond-external\n",
      );
      expect(runQaSuiteCommand).not.toHaveBeenCalled();
      expect(resolveLiveTransportQaScenarioIds).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
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
        id: "discord-e2e-doctor",
        title: "External discord-e2e-doctor",
        sourcePath: file,
        execution: {
          timeoutMs: 23456,
          retryCount: 0,
          config: { agentE2e: true, marker: "external-recipe" },
          flow: { steps: [{ name: "native readiness", actions: [{ call: "channelE2e.doctor" }] }] },
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
    await expectQaFailure(["--scenario-file", file], fixture.expected);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
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
    await expectQaFailure(args, expected);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects colliding file scenario ids instead of silently replacing a flow", async () => {
    const firstDir = tempDirs.make("agent-e2e-first-");
    const secondDir = tempDirs.make("agent-e2e-second-");
    const first = await writeAgentE2eRecipe(firstDir, "collision");
    const second = await writeAgentE2eRecipe(secondDir, "collision", { timeoutMs: 9999 });
    await expectQaFailure(
      ["--scenario-file", first, "--scenario-file", second],
      /duplicate QA scenario id/u,
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty scenario file in the argument parser before dispatch", async () => {
    await expect(parseQa("discord", "--scenario-file", " ")).rejects.toThrow(
      /non-empty YAML file path/u,
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "discord",
        defaultProviderMode: "live-frontier",
        options: { providerMode: "unknown" },
        selectScenarioIds: () => ["discord-canary"],
      }),
    ).rejects.toThrow("unknown QA provider mode: unknown");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
