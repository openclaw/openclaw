import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  dockerLaneName,
  dockerE2eLaneName,
  prepareDockerE2eEnvironment,
  type QaPreparedDockerEvidence,
} from "./test-file-scenario-docker-batch.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";
import {
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeDockerE2eScenario,
  makeTestFileScenario,
  resolveScriptAttemptOutputDir,
  writeDockerCandidateManifest,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);

afterEach(async () => {
  vi.unstubAllEnvs();
  await harness.cleanup();
});

it("prepares declared candidates for scripts that own their Docker invocation", () => {
  const scenario = makeTestFileScenario("script", "scripts/e2e/qa-cli-onboarding.mjs");
  if (scenario.execution.kind !== "script") {
    throw new Error("expected script scenario");
  }
  expect(
    dockerLaneName({
      ...scenario,
      execution: { ...scenario.execution, dockerLane: "onboard" },
    }),
  ).toBe("onboard");
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
  const outputDir = path.join(repoRoot, "out");
  const packagePath = path.join(repoRoot, "openclaw.tgz");
  const registryDir = path.join(repoRoot, "registry");
  const onboardingScenario = makeTestFileScenario("script", "scripts/e2e/qa-cli-onboarding.mjs");
  if (onboardingScenario.execution.kind !== "script") {
    throw new Error("expected script scenario");
  }
  const runCommand = vi.fn(async (command: QaScenarioCommandExecution) => {
    expect(command.env).toMatchObject({
      KEEP_ME: "yes",
      OPENCLAW_DOCKER_ALL_LANES: "gateway-network,openai-chat-tools,onboard",
      OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot,
    });
    expect(command.env).not.toHaveProperty("OPENCLAW_DOCKER_ALL_BUILD");
    expect(command.env).not.toHaveProperty("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(command.env).not.toHaveProperty("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR");
    return await writeDockerCandidateManifest(command, {
      schema: "openclaw.qa-docker-candidate/v1",
      schemaVersion: 1,
      sourceSha: "a".repeat(40),
      candidate: {
        package: {
          path: packagePath,
          name: "openclaw",
          version: "2026.8.1",
          sha256: "b".repeat(64),
        },
        registry: {
          dir: registryDir,
          candidateVersion: "2026.8.1",
          manifestSha256: "c".repeat(64),
        },
      },
    });
  });
  const env = await prepareDockerE2eEnvironment({
    env: {
      KEEP_ME: "yes",
      OPENCLAW_DOCKER_ALL_BUILD: "1",
      OPENCLAW_CURRENT_PACKAGE_TGZ: "/stale.tgz",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "/stale-registry",
    },
    outputDir,
    repoRoot,
    runCommand,
    scenarios: [
      makeDockerE2eScenario("one", "gateway-network"),
      makeDockerE2eScenario("duplicate", "gateway-network"),
      makeDockerE2eScenario("two", "openai-chat-tools"),
      {
        ...onboardingScenario,
        execution: { ...onboardingScenario.execution, dockerLane: "onboard" },
      },
    ],
  });

  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(env)).toBe(true);
  expect(env).toEqual({
    KEEP_ME: "yes",
    OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot,
    OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
    OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
    OPENCLAW_CURRENT_PACKAGE_VERSION: "2026.8.1",
    OPENCLAW_CURRENT_PACKAGE_SHA256: "b".repeat(64),
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "c".repeat(64),
  });
});

it("returns a sanitized bound env for a package-free candidate", async () => {
  const repoRoot = await makeTempRepo("qa-docker-candidate-null-");
  const env = await prepareDockerE2eEnvironment({
    env: {
      KEEP_ME: "yes",
      OPENCLAW_DOCKER_ALL_BUILD: "1",
      OPENCLAW_CURRENT_PACKAGE_TGZ: "/stale.tgz",
    },
    outputDir: path.join(repoRoot, "out"),
    repoRoot,
    runCommand: (command) =>
      writeDockerCandidateManifest(command, {
        schema: "openclaw.qa-docker-candidate/v1",
        schemaVersion: 1,
        sourceSha: "a".repeat(40),
        candidate: null,
      }),
    scenarios: [makeDockerE2eScenario("one", "gateway-network")],
  });

  expect(env).toEqual({ KEEP_ME: "yes", OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot });
  expect(Object.isFrozen(env)).toBe(true);
});

it("retains immutable prepared Docker receipts without claiming installed or runtime proof", async () => {
  const repoRoot = await makeTempRepo("qa-docker-prepared-evidence-");
  const scenario = makeDockerE2eScenario("one", "gateway-network");
  const captured: QaPreparedDockerEvidence[] = [];
  const prepare = async () =>
    prepareDockerE2eEnvironment({
      env: {},
      repoRoot,
      outputDir: path.join(repoRoot, "prep"),
      scenarios: [scenario],
      onPrepared: (evidence) => captured.push(evidence),
      runCommand: (command) =>
        writeDockerCandidateManifest(command, {
          schema: "openclaw.qa-docker-candidate/v1",
          schemaVersion: 1,
          sourceSha: "a".repeat(40),
          candidate: {
            package: {
              path: path.join(repoRoot, "candidate.tgz"),
              name: "openclaw",
              version: "2026.8.1",
              sha256: "b".repeat(64),
            },
            registry: null,
          },
        }),
    });
  const env = await prepare();
  const first = captured[0]!;
  const firstPath = resolveQaArtifactPath(repoRoot, repoRoot, first.receipt.artifact.path);
  const original = await fs.readFile(firstPath);
  await prepare();
  expect(captured[1]?.receipt.artifact.path).not.toBe(first.receipt.artifact.path);
  expect(await fs.readFile(firstPath)).toEqual(original);
  expect(createHash("sha256").update(original).digest("hex")).toBe(first.receipt.artifact.sha256);
  const result = await runQaTestFileScenarios({
    ...QA_TEST_RUNNER_DEFAULTS,
    repoRoot,
    outputDir: path.join(repoRoot, "run"),
    env,
    envMode: "replace",
    preparedDockerEvidence: first,
    scenarios: [scenario],
    failFast: true,
    runCommand: async () => ({ exitCode: 0, stdout: "completed", stderr: "" }),
  });
  if (result.evidence.schemaVersion !== 3) {
    throw new Error("expected occurrence evidence");
  }
  const receipts = result.evidence.occurrences.flatMap((occurrence) => occurrence.receipts);
  expect(receipts).toContainEqual(first.receipt);
  expect(receipts.every((receipt) => receipt.phase === "prepared")).toBe(true);
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
  const launch = {
    ...first.receipt.identity,
    source: { ref: "a".repeat(40), integrity: null },
    package: null,
  };
  for (const mismatch of ["package", "source"] as const) {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const owner = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch: {
        ...launch,
        source: {
          ...launch.source,
          ref: mismatch === "source" ? "c".repeat(40) : launch.source.ref,
        },
      },
    });
    await expect(
      runQaTestFileScenarios({
        ...QA_TEST_RUNNER_DEFAULTS,
        repoRoot,
        outputDir: path.join(repoRoot, mismatch),
        env: {
          ...env,
          ...(mismatch === "package" ? { OPENCLAW_CURRENT_PACKAGE_SHA256: "d".repeat(64) } : {}),
        },
        envMode: "replace",
        preparedDockerEvidence: first,
        evidenceAnchors: owner.anchors,
        scenarios: [scenario],
        failFast: true,
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

it.each([
  { label: "extra field", patch: { extra: true } },
  { label: "malformed candidate", patch: { candidate: { package: null, registry: null } } },
])("rejects a $label in the Docker candidate manifest", async ({ patch }) => {
  const repoRoot = await makeTempRepo("qa-docker-candidate-invalid-");
  await expect(
    prepareDockerE2eEnvironment({
      env: process.env,
      outputDir: path.join(repoRoot, "out"),
      repoRoot,
      runCommand: (command) =>
        writeDockerCandidateManifest(command, {
          schema: "openclaw.qa-docker-candidate/v1",
          schemaVersion: 1,
          sourceSha: "a".repeat(40),
          candidate: null,
          ...patch,
        }),
      scenarios: [makeDockerE2eScenario("one", "gateway-network")],
    }),
  ).rejects.toThrow();
});

describe("qa test file scenario runner", () => {
  it.each([
    { firstFails: false, lastId: "same" },
    { firstFails: true, lastId: "same" },
    { firstFails: true, lastId: "different" },
  ])(
    "executes repeated Docker lanes independently ($firstFails, $lastId)",
    async ({ firstFails, lastId }) => {
      const repoRoot = await makeTempRepo("qa-docker-repeated-lanes-");
      const repeated = makeDockerE2eScenario("same", "gateway-network");
      const scenarios = [
        repeated,
        makeDockerE2eScenario("other", "openai-chat-tools"),
        makeDockerE2eScenario(lastId, "gateway-network"),
      ];
      const prepareCommand = vi.fn((command: QaScenarioCommandExecution) =>
        writeDockerCandidateManifest(command, {
          schema: "openclaw.qa-docker-candidate/v1",
          schemaVersion: 1,
          sourceSha: "a".repeat(40),
          candidate: null,
        }),
      );
      const env = await prepareDockerE2eEnvironment({
        env: {},
        repoRoot,
        outputDir: path.join(repoRoot, "prep"),
        scenarios,
        runCommand: prepareCommand,
      });
      const commands: QaScenarioCommandExecution[] = [];
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir: path.join(repoRoot, "out"),
        ...QA_TEST_RUNNER_DEFAULTS,
        env,
        envMode: "replace",
        scenarios,
        runCommand: async (command) => {
          commands.push(command);
          const failed = commands.length === (firstFails ? 1 : 2);
          const names = command.env.OPENCLAW_DOCKER_ALL_LANES!.split(",");
          const lanes = names.map((name) => ({
            name,
            elapsedSeconds: 1,
            status: failed ? 1 : 0,
          }));
          await fs.writeFile(
            path.join(command.env.OPENCLAW_DOCKER_ALL_LOG_DIR!, "summary.json"),
            JSON.stringify({
              selectedLanes: names,
              lanes,
              failures: lanes.filter((lane) => lane.status !== 0),
            }),
          );
          return {
            exitCode: failed ? 1 : 0,
            stdout: `actual batch ${commands.length}`,
            stderr: "",
          };
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
        ["same", firstFails ? "fail" : "pass"],
        ["other", firstFails ? "fail" : "pass"],
        [lastId, firstFails ? "pass" : "fail"],
      ]);
      const [first, , last] = result.results;
      expect(last!.logPath).not.toBe(first!.logPath);
      expect(await fs.readFile(first!.logPath, "utf8")).toContain("actual batch 1");
      expect(await fs.readFile(last!.logPath, "utf8")).toContain("actual batch 2");
      expect(new Set(result.results.map((entry) => entry.evidenceOccurrenceId)).size).toBe(3);
    },
  );

  it.each([
    { label: "package", candidate: "package" as const },
    { label: "package-free", candidate: "none" as const },
  ])("keeps hostile inherited Docker state out of a prepared $label run", async ({ candidate }) => {
    const repoRoot = await makeTempRepo("qa-docker-replace-env-");
    const packagePath = path.join(repoRoot, "openclaw.tgz");
    vi.stubEnv("OPENCLAW_DOCKER_ALL_POISON", "hostile");
    vi.stubEnv("OPENCLAW_CURRENT_PACKAGE_TGZ", "/hostile.tgz");
    vi.stubEnv("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR", "/hostile-registry");
    const prepared = await prepareDockerE2eEnvironment({
      env: process.env,
      outputDir: path.join(repoRoot, "prep"),
      repoRoot,
      runCommand: (command) =>
        writeDockerCandidateManifest(command, {
          schema: "openclaw.qa-docker-candidate/v1",
          schemaVersion: 1,
          sourceSha: "a".repeat(40),
          candidate:
            candidate === "package"
              ? {
                  package: {
                    path: packagePath,
                    name: "openclaw",
                    version: "2026.8.1",
                    sha256: "b".repeat(64),
                  },
                  registry: null,
                }
              : null,
        }),
      scenarios: [makeDockerE2eScenario("one", "gateway-network")],
    });

    await runQaTestFileScenarios({
      env: prepared,
      envMode: "replace",
      outputDir: path.join(repoRoot, "run"),
      ...QA_TEST_RUNNER_DEFAULTS,
      repoRoot,
      scenarios: [makeDockerE2eScenario("one", "gateway-network")],
      runCommand: async (command) => {
        expect(command.env.OPENCLAW_DOCKER_ALL_POISON).toBeUndefined();
        expect(command.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR).toBeUndefined();
        expect(command.env.OPENCLAW_CURRENT_PACKAGE_TGZ).toBe(
          candidate === "package" ? packagePath : undefined,
        );
        expect(command.env.OPENCLAW_DOCKER_E2E_REPO_ROOT).toBe(repoRoot);
        const logDir = command.env.OPENCLAW_DOCKER_ALL_LOG_DIR!;
        await fs.mkdir(logDir, { recursive: true });
        await fs.writeFile(
          path.join(logDir, "summary.json"),
          JSON.stringify({
            failures: [],
            lanes: [{ elapsedSeconds: 1, name: "gateway-network", status: 0 }],
            selectedLanes: ["gateway-network"],
          }),
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
  });

  it("preserves individual Docker lane success without generic producer evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-docker-individual-no-producer-evidence-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "docker-individual"),
      ...QA_TEST_RUNNER_DEFAULTS,
      failFast: true,
      scenarios: [makeDockerE2eScenario("docker-gateway-network", "gateway-network")],
      runCommand: async () => ({ exitCode: 0, stdout: "Docker lane passed\n", stderr: "" }),
    });

    expect(result.results[0]).toMatchObject({
      scenario: { id: "docker-gateway-network" },
      status: "pass",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("pass");
  });

  it("prioritizes serial native work while preserving catalog-ordered mixed evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-docker-priority-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "native-priority");
    const makeScriptScenario = (id: string, timeoutMs: number) => {
      const scenario = makeTestFileScenario("script", `scripts/${id}.ts`);
      if (scenario.execution.kind !== "script") {
        throw new Error("expected script scenario");
      }
      return { ...scenario, id, execution: { ...scenario.execution, timeoutMs } };
    };
    const dockerScenario = makeDockerE2eScenario("long-docker", "gateway-network");
    if (dockerScenario.execution.kind !== "script") {
      throw new Error("expected Docker script scenario");
    }
    const scenarios = [
      makeScriptScenario("short-script", 1_000),
      { ...dockerScenario, execution: { ...dockerScenario.execution, timeoutMs: 3_000 } },
      makeScriptScenario("long-script-a", 3_000),
      makeScriptScenario("long-script-b", 3_000),
      {
        ...dockerScenario,
        id: "short-docker",
        execution: { ...dockerScenario.execution, timeoutMs: 1_000 },
      },
    ];
    const executionOrder: string[] = [];
    const output: string[] = [];
    const progress: string[] = [];
    let activeCommands = 0;
    let maximumActiveCommands = 0;

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios,
      onCommandOutput: (stream, chunk) => output.push(`${stream}:${chunk.toString("utf8")}`),
      progress: (message) => progress.push(message),
      runCommand: async (command) => {
        const isDocker = command.args[0] === "scripts/test-docker-all.mjs";
        let scenarioId =
          command.env.OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS === "3000"
            ? "long-docker"
            : "short-docker";
        if (!isDocker) {
          const scriptPath = command.args[2];
          if (!scriptPath) {
            throw new Error("missing script scenario path");
          }
          scenarioId = path.basename(scriptPath, ".ts");
        }
        executionOrder.push(scenarioId);
        activeCommands += 1;
        maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
        try {
          command.onOutput?.("stdout", Buffer.from(scenarioId));
          if (isDocker) {
            const logDir = command.env.OPENCLAW_DOCKER_ALL_LOG_DIR;
            if (!logDir) {
              throw new Error("missing Docker scheduler log dir");
            }
            await fs.mkdir(logDir, { recursive: true });
            await fs.writeFile(
              path.join(logDir, "summary.json"),
              JSON.stringify({
                failures: [],
                lanes: [{ elapsedSeconds: 1, name: "gateway-network", status: 0 }],
                selectedLanes: ["gateway-network"],
              }),
            );
          } else {
            await writeScriptProducerEvidence({
              outputDir: resolveScriptAttemptOutputDir(command),
              producerId: scenarioId,
              scenarioId,
              status: "pass",
            });
          }
          return { exitCode: 0, stdout: `${scenarioId} passed\n`, stderr: "" };
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
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios,
      runCommand: async (command) => {
        commands.push(command);
        expect(await fs.readFile(staleSummaryPath, "utf8")).toBe('{"status":"passed"}\n');
        const logDir = command.env.OPENCLAW_DOCKER_ALL_LOG_DIR;
        if (!logDir) {
          throw new Error("missing Docker scheduler log dir");
        }
        await fs.mkdir(logDir, { recursive: true });
        const failedLane = { elapsedSeconds: 2, name: "gateway-network", status: 1 };
        await fs.writeFile(
          path.join(logDir, "summary.json"),
          `${JSON.stringify({
            failures: [failedLane],
            lanes: [
              { elapsedSeconds: 4, name: "openai-chat-tools", status: 0 },
              { elapsedSeconds: 7, name: "bundled-plugin-install-uninstall-0", status: 0 },
              { elapsedSeconds: 6, name: "bundled-plugin-install-uninstall-1", status: 0 },
              { elapsedSeconds: 1, name: "gateway", status: 0 },
              failedLane,
            ],
            selectedLanes: [
              "openai-chat-tools",
              "bundled-plugin-install-uninstall-0",
              "bundled-plugin-install-uninstall-1",
              "gateway",
              "gateway-network",
            ],
          })}\n`,
          "utf8",
        );
        return { exitCode: 1, stdout: "", stderr: "scheduler failed\n" };
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
