import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import type {
  QaScenarioCommandExecution,
  runQaScenarioCommandLifecycle,
} from "./test-file-scenario-command-lifecycle.js";
import {
  dockerE2eLaneName,
  prepareDockerE2eEnvironment as prepareActualDockerE2eEnvironment,
  type QaPreparedDockerEvidence,
} from "./test-file-scenario-docker-batch.js";
import {
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeDockerE2eScenario,
  makeTestFileScenario,
  resolveScriptAttemptOutputDir,
  runQaTestFileScenariosWithCommand as runQaTestFileScenarios,
  withQaScenarioCommand,
  writeDockerCandidateManifest,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

async function prepareDockerE2eEnvironment({
  runCommand,
  ...params
}: Parameters<typeof prepareActualDockerE2eEnvironment>[0] & {
  runCommand?: typeof runQaScenarioCommandLifecycle;
}) {
  return withQaScenarioCommand(runCommand, () => prepareActualDockerE2eEnvironment(params));
}

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);
type RunOptions = Parameters<typeof runQaTestFileScenarios>[0];
type PrepareOptions = Parameters<typeof prepareDockerE2eEnvironment>[0];
type ScriptExecution = Extract<RunOptions["scenarios"][number]["execution"], { kind: "script" }>;
const packageInfo = { name: "openclaw", version: "2026.8.1", sha256: "b".repeat(64) };
const registryInfo = { candidateVersion: "2026.8.1", manifestSha256: "c".repeat(64) };
const commandResult = (exitCode = 0, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });

function candidateManifest(repoRoot?: string, registry = false, packageName = "candidate.tgz") {
  return {
    schema: "openclaw.qa-docker-candidate/v1",
    schemaVersion: 1,
    sourceSha: "a".repeat(40),
    candidate: repoRoot
      ? {
          package: { ...packageInfo, path: path.join(repoRoot, packageName) },
          registry: registry ? { ...registryInfo, dir: path.join(repoRoot, "registry") } : null,
        }
      : null,
  };
}

function scriptScenario(id: string, file: string, execution: Partial<ScriptExecution> = {}) {
  const scenario = makeTestFileScenario("script", file);
  if (scenario.execution.kind !== "script") {
    throw new Error("expected script scenario");
  }
  return { ...scenario, id, execution: { ...scenario.execution, ...execution } };
}

function prepare(
  repoRoot: string,
  options: Partial<PrepareOptions> & Pick<PrepareOptions, "scenarios">,
) {
  return prepareDockerE2eEnvironment({
    repoRoot,
    outputDir: path.join(repoRoot, "prep"),
    env: {},
    runCommand: (command) => writeDockerCandidateManifest(command, candidateManifest()),
    ...options,
  });
}

function run(repoRoot: string, options: Partial<RunOptions> & Pick<RunOptions, "scenarios">) {
  return runQaTestFileScenarios({
    repoRoot,
    outputDir: path.join(repoRoot, "run"),
    ...QA_TEST_RUNNER_DEFAULTS,
    ...options,
  });
}

async function writeSummary(
  command: QaScenarioCommandExecution,
  statuses: Record<string, number> = { "gateway-network": 0 },
) {
  const logDir = command.env.OPENCLAW_DOCKER_ALL_LOG_DIR;
  if (!logDir) {
    throw new Error("missing Docker scheduler log dir");
  }
  const lanes = Object.entries(statuses).map(([name, status]) => ({
    name,
    status,
    elapsedSeconds: 1,
  }));
  await fs.writeFile(
    path.join(logDir, "summary.json"),
    JSON.stringify({
      failures: lanes.filter((lane) => lane.status !== 0),
      lanes,
      selectedLanes: lanes.map((lane) => lane.name),
    }),
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await harness.cleanup();
});

it("only batches the canonical Docker lane argument shape", () => {
  const scenario = makeDockerE2eScenario("docker-lane", "gateway-network");
  if (scenario.execution.kind !== "script") {
    throw new Error("expected script scenario");
  }
  expect(dockerE2eLaneName(scenario)).toBe("gateway-network");
  expect(
    dockerE2eLaneName({
      ...scenario,
      execution: { ...scenario.execution, args: ["--lane", "gateway-network", "--extra"] },
    }),
  ).toBeUndefined();
});

it("prepares the exact Docker lane union in a sanitized bound environment", async () => {
  const repoRoot = await makeTempRepo("qa-docker-candidate-");
  const runCommand = vi.fn(async (command: QaScenarioCommandExecution) => {
    expect(command.env).toMatchObject({
      KEEP_ME: "yes",
      OPENCLAW_DOCKER_ALL_LANES: "gateway-network,openai-chat-tools,onboard",
      OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot,
    });
    expect(command.env).not.toHaveProperty("OPENCLAW_DOCKER_ALL_BUILD");
    expect(command.env).not.toHaveProperty("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(command.env).not.toHaveProperty("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR");
    return writeDockerCandidateManifest(command, candidateManifest(repoRoot, true, "openclaw.tgz"));
  });
  const env = await prepare(repoRoot, {
    env: {
      KEEP_ME: "yes",
      OPENCLAW_DOCKER_ALL_BUILD: "1",
      OPENCLAW_CURRENT_PACKAGE_TGZ: "/stale.tgz",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "/stale-registry",
    },
    runCommand,
    scenarios: [
      makeDockerE2eScenario("one", "gateway-network"),
      makeDockerE2eScenario("duplicate", "gateway-network"),
      makeDockerE2eScenario("two", "openai-chat-tools"),
      scriptScenario("scenario-script", "scripts/e2e/qa-cli-onboarding.mjs", {
        dockerLane: "onboard",
      }),
    ],
  });

  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(env)).toBe(true);
  expect(env).toEqual({
    KEEP_ME: "yes",
    OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot,
    OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
    OPENCLAW_CURRENT_PACKAGE_TGZ: path.join(repoRoot, "openclaw.tgz"),
    OPENCLAW_CURRENT_PACKAGE_VERSION: "2026.8.1",
    OPENCLAW_CURRENT_PACKAGE_SHA256: "b".repeat(64),
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: path.join(repoRoot, "registry"),
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "c".repeat(64),
  });
});

it("keeps prepared Docker receipts immutable and rejects launch/environment mismatches", async () => {
  const repoRoot = await makeTempRepo("qa-docker-prepared-evidence-");
  const scenario = makeDockerE2eScenario("one", "gateway-network");
  const captured: QaPreparedDockerEvidence[] = [];
  const prepareCandidate = () =>
    prepare(repoRoot, {
      scenarios: [scenario],
      onPrepared: (evidence) => captured.push(evidence),
      runCommand: (command) => writeDockerCandidateManifest(command, candidateManifest(repoRoot)),
    });
  const env = await prepareCandidate();
  const first = captured[0]!;
  const runPrepared = (options: Partial<RunOptions>) =>
    run(repoRoot, {
      env,
      envMode: "replace",
      preparedDockerEvidence: first,
      scenarios: [scenario],
      failFast: true,
      ...options,
    });
  const firstPath = resolveQaArtifactPath(repoRoot, repoRoot, first.receipt.artifact.path);
  const original = await fs.readFile(firstPath);
  await prepareCandidate();
  expect(captured[1]?.receipt.artifact.path).not.toBe(first.receipt.artifact.path);
  expect(await fs.readFile(firstPath)).toEqual(original);
  expect(createHash("sha256").update(original).digest("hex")).toBe(first.receipt.artifact.sha256);
  expect(first.receipt.identity).toEqual({
    source: { ref: "a".repeat(40), integrity: null },
    runtime: { id: null, version: null },
    package: {
      kind: "npm-tarball",
      spec: "openclaw",
      version: "2026.8.1",
      integrity: `sha256:${"b".repeat(64)}`,
    },
    protocol: null,
    accountRef: null,
    proofClass: null,
  });
  for (const mismatch of ["package", "source"] as const) {
    const runCommand = vi.fn(async () => commandResult());
    const owner = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch: {
        ...first.receipt.identity,
        source: { ref: (mismatch === "source" ? "c" : "a").repeat(40), integrity: null },
        package: null,
      },
    });
    await expect(
      runPrepared({
        outputDir: path.join(repoRoot, mismatch),
        env: {
          ...env,
          ...(mismatch === "package" ? { OPENCLAW_CURRENT_PACKAGE_SHA256: "d".repeat(64) } : {}),
        },
        evidenceAnchors: owner.anchors,
        runCommand,
      }),
    ).rejects.toThrow(
      mismatch === "package"
        ? "Docker child environment differs"
        : "Docker candidate source differs",
    );
    expect(runCommand).not.toHaveBeenCalled();
  }
});

describe("qa test file scenario runner", () => {
  it("executes repeated Docker lanes independently after an earlier failure", async () => {
    const repoRoot = await makeTempRepo("qa-docker-repeated-lanes-");
    const scenarios = [
      makeDockerE2eScenario("same", "gateway-network"),
      makeDockerE2eScenario("other", "openai-chat-tools"),
      makeDockerE2eScenario("same", "gateway-network"),
    ];
    const prepareCommand = vi.fn((command: QaScenarioCommandExecution) =>
      writeDockerCandidateManifest(command, candidateManifest()),
    );
    const env = await prepare(repoRoot, {
      scenarios,
      runCommand: prepareCommand,
    });
    const commands: QaScenarioCommandExecution[] = [];
    const result = await run(repoRoot, {
      outputDir: path.join(repoRoot, "out"),
      env,
      envMode: "replace",
      scenarios,
      runCommand: async (command) => {
        commands.push(command);
        const exitCode = commands.length === 1 ? 1 : 0;
        const names = command.env.OPENCLAW_DOCKER_ALL_LANES!.split(",");
        await writeSummary(command, Object.fromEntries(names.map((name) => [name, exitCode])));
        return commandResult(exitCode, `actual batch ${commands.length}`);
      },
    });
    expect(prepareCommand).toHaveBeenCalledTimes(1);
    expect(prepareCommand.mock.calls[0]![0].env.OPENCLAW_DOCKER_ALL_LANES).toBe(
      "gateway-network,openai-chat-tools",
    );
    expect(commands.map((command) => command.env.OPENCLAW_DOCKER_ALL_LANES)).toEqual([
      "gateway-network,openai-chat-tools",
      "gateway-network",
    ]);
    expect(result.results.map((entry) => [entry.scenario.id, entry.status])).toEqual([
      ["same", "fail"],
      ["other", "fail"],
      ["same", "pass"],
    ]);
    const [first, , last] = result.results;
    expect(last!.logPath).not.toBe(first!.logPath);
    expect(await fs.readFile(first!.logPath, "utf8")).toContain("actual batch 1");
    expect(await fs.readFile(last!.logPath, "utf8")).toContain("actual batch 2");
    expect(new Set(result.results.map((entry) => entry.evidenceOccurrenceId)).size).toBe(3);
  });

  it("keeps hostile inherited Docker state out of a prepared package-free run", async () => {
    const repoRoot = await makeTempRepo("qa-docker-replace-env-");
    vi.stubEnv("OPENCLAW_DOCKER_ALL_POISON", "hostile");
    vi.stubEnv("OPENCLAW_CURRENT_PACKAGE_TGZ", "/hostile.tgz");
    vi.stubEnv("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR", "/hostile-registry");
    const prepared = await prepare(repoRoot, {
      env: { ...process.env, KEEP_ME: "yes" },
      scenarios: [makeDockerE2eScenario("one", "gateway-network")],
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared).toHaveProperty("KEEP_ME", "yes");

    await run(repoRoot, {
      env: prepared,
      envMode: "replace",
      scenarios: [makeDockerE2eScenario("one", "gateway-network")],
      runCommand: async (command) => {
        expect(command.env.OPENCLAW_DOCKER_ALL_POISON).toBeUndefined();
        expect(command.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR).toBeUndefined();
        expect(command.env.OPENCLAW_CURRENT_PACKAGE_TGZ).toBe(undefined);
        expect(command.env.OPENCLAW_DOCKER_E2E_REPO_ROOT).toBe(repoRoot);
        await writeSummary(command);
        return commandResult();
      },
    });
  });

  it("prioritizes serial native work while preserving catalog-ordered mixed evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-docker-priority-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "native-priority");
    const schedule: [string, number][] = [
      ["short-script", 1_000],
      ["long-docker", 3_000],
      ["long-script-a", 3_000],
      ["long-script-b", 3_000],
      ["short-docker", 1_000],
    ];
    const scenarios = schedule.map(([id, timeoutMs]) =>
      scriptScenario(
        id,
        id.endsWith("docker") ? "test/e2e/qa-lab/runtime/docker-e2e-lane.ts" : `scripts/${id}.ts`,
        {
          timeoutMs,
          ...(id.endsWith("docker") ? { args: ["--lane", "gateway-network"] } : {}),
        },
      ),
    );
    const executionOrder: string[] = [];
    const output: string[] = [];
    const progress: string[] = [];
    let activeCommands = 0;
    let maximumActiveCommands = 0;

    const result = await run(repoRoot, {
      outputDir,
      scenarios,
      onCommandOutput: (stream, chunk) => output.push(`${stream}:${chunk.toString("utf8")}`),
      progress: (message) => progress.push(message),
      runCommand: async (command) => {
        const isDocker = command.args[0] === "scripts/test-docker-all.mjs";
        const scenarioId = isDocker
          ? command.env.OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS === "3000"
            ? "long-docker"
            : "short-docker"
          : path.basename(command.args[2]!, ".ts");
        executionOrder.push(scenarioId);
        activeCommands += 1;
        maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
        try {
          command.onOutput?.("stdout", Buffer.from(scenarioId));
          if (isDocker) {
            await writeSummary(command);
          } else {
            await writeScriptProducerEvidence({
              outputDir: resolveScriptAttemptOutputDir(command),
              producerId: scenarioId,
              scenarioId,
              status: "pass",
            });
          }
          return commandResult(0, `${scenarioId} passed\n`);
        } finally {
          activeCommands -= 1;
        }
      },
    });

    expect(executionOrder).toEqual([
      "long-docker",
      "long-script-a",
      "long-script-b",
      "short-script",
      "short-docker",
    ]);
    expect(maximumActiveCommands).toBe(1);
    expect(output).toEqual(executionOrder.map((scenarioId) => `stdout:${scenarioId}`));
    expect(progress.filter((message) => message.includes(" start "))).toEqual([
      "native docker-batch start scenarios=1 timeoutMs=3000",
      "native script start scenario=long-script-a timeoutMs=3000",
      "native script start scenario=long-script-b timeoutMs=3000",
      "native script start scenario=short-script timeoutMs=1000",
      "native docker-batch start scenarios=1 timeoutMs=1000",
    ]);
    const catalogOrder = scenarios.map((scenario) => scenario.id);
    expect(result.results.map((entry) => entry.scenario.id)).toEqual(catalogOrder);
    expect(result.evidence.entries.map((entry) => entry.test.id)).toEqual(catalogOrder);
  });

  it("runs Docker script scenarios through one aggregate scheduler invocation", async () => {
    const repoRoot = await makeTempRepo("qa-script-docker-batch-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "docker-batch");
    const staleSummaryPath = path.join(outputDir, "docker-e2e-1800000ms", "summary.json");
    await fs.mkdir(path.dirname(staleSummaryPath), { recursive: true });
    await fs.writeFile(staleSummaryPath, '{"status":"passed"}\n', "utf8");
    const commands: QaScenarioCommandExecution[] = [];
    const scenarios = [
      makeDockerE2eScenario("openai-tools", "openai-chat-tools"),
      makeDockerE2eScenario("bundled-plugins", "bundled-plugin-install-uninstall"),
      makeDockerE2eScenario("prefix-lane", "gateway"),
      makeDockerE2eScenario("failing-lane", "gateway-network"),
    ];
    const result = await run(repoRoot, {
      outputDir,
      scenarios,
      runCommand: async (command) => {
        commands.push(command);
        expect(await fs.readFile(staleSummaryPath, "utf8")).toBe('{"status":"passed"}\n');
        await writeSummary(command, {
          "openai-chat-tools": 0,
          "bundled-plugin-install-uninstall-0": 0,
          "bundled-plugin-install-uninstall-1": 0,
          gateway: 0,
          "gateway-network": 1,
        });
        return commandResult(1, "", "scheduler failed\n");
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      args: ["scripts/test-docker-all.mjs"],
      command: process.execPath,
      env: {
        OPENCLAW_DOCKER_ALL_FAIL_FAST: "0",
        OPENCLAW_DOCKER_ALL_LANES:
          "openai-chat-tools,bundled-plugin-install-uninstall,gateway,gateway-network",
        OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS: "1800000",
      },
    });
    expect(result.results).toMatchObject([
      { scenario: { id: "openai-tools" }, status: "pass" },
      { scenario: { id: "bundled-plugins" }, status: "pass" },
      { scenario: { id: "prefix-lane" }, status: "pass" },
      { scenario: { id: "failing-lane" }, status: "fail" },
    ]);
    expect(result.results[3]?.failureMessage).toBe("gateway-network exited with 1");
  });
});
