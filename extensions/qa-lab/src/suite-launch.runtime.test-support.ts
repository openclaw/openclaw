import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

const {
  crablineRuntimeLoads,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  runPluginCommandWithTimeout,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = vi.hoisted(() => ({
  crablineRuntimeLoads: vi.fn(),
  prepareDockerE2eEnvironment: vi.fn(),
  replaceFileAtomicMock: vi.fn(),
  runPluginCommandWithTimeout: vi.fn(),
  runQaFlowSuite: vi.fn(),
  runQaTestFileScenarios: vi.fn(),
}));

vi.mock("@openclaw/crabline", async (importOriginal) => {
  crablineRuntimeLoads();
  return await importOriginal<typeof import("@openclaw/crabline")>();
});

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

vi.mock("./test-file-scenario-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-runner.js")>()),
  runQaTestFileScenarios,
}));

vi.mock("./test-file-scenario-docker-batch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-docker-batch.js")>()),
  prepareDockerE2eEnvironment,
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({ runPluginCommandWithTimeout }));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  replaceFileAtomicMock.mockImplementation(actual.replaceFileAtomic);
  return { ...actual, replaceFileAtomic: replaceFileAtomicMock };
});

const tempRoots: string[] = [];

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  return repoRoot;
}

async function writeEvidence(pathLocal: string, writeFile = true) {
  const evidence = {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    entries: [],
  };
  if (writeFile) {
    await fs.mkdir(path.dirname(pathLocal), { recursive: true });
    await fs.writeFile(pathLocal, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  return evidence;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requireDefaultQaFlowSuiteImplementation() {
  const implementation = runQaFlowSuite.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA flow suite mock implementation");
  }
  return implementation;
}

function requireDefaultQaTestFileImplementation() {
  const implementation = runQaTestFileScenarios.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA test-file mock implementation");
  }
  return implementation;
}

beforeEach(() => {
  replaceFileAtomicMock.mockClear();
  runQaFlowSuite.mockReset();
  runQaTestFileScenarios.mockReset();
  prepareDockerE2eEnvironment.mockReset();
  prepareDockerE2eEnvironment.mockResolvedValue(undefined);
  runPluginCommandWithTimeout.mockReset();
  runPluginCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  runQaFlowSuite.mockImplementation(
    async (
      params:
        | { outputDir?: string; scenarioIds?: string[]; writeEvidenceFile?: boolean }
        | undefined,
    ) => {
      const outputDir = params?.outputDir ?? "/tmp/qa-flow";
      const evidencePath = path.join(outputDir, "qa-evidence.json");
      const evidence = await writeEvidence(evidencePath, params?.writeEvidenceFile);
      const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
      return {
        evidence,
        outputDir,
        evidencePath,
        reportPath: path.join(outputDir, "qa-suite-report.md"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
        report: "# QA Suite Report\n",
        scenarios: scenarioIds.map((scenarioId) => ({
          name: scenarioId,
          status: "pass",
          steps: [],
        })),
        startedScenarioIds: scenarioIds,
        watchUrl: "http://127.0.0.1:43124",
      };
    },
  );
  runQaTestFileScenarios.mockImplementation(
    async (params: {
      outputDir: string;
      scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
      writeEvidenceFile?: boolean;
    }) => {
      const [scenario] = params.scenarios;
      if (!scenario) {
        throw new Error("expected scenario");
      }
      const evidencePath = path.join(params.outputDir, "qa-evidence.json");
      const evidence = await writeEvidence(evidencePath, params.writeEvidenceFile);
      return {
        evidence,
        outputDir: params.outputDir,
        executionKind: scenario.execution.kind,
        evidencePath,
        results: params.scenarios.map((scenarioItem) => ({
          durationMs: 1,
          logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
          scenario: scenarioItem,
          status: "pass",
        })),
      };
    },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

export {
  crablineRuntimeLoads,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  runPluginCommandWithTimeout,
  runQaFlowSuite,
  runQaTestFileScenarios,
  makeTempRepo,
  createDeferred,
  requireDefaultQaFlowSuiteImplementation,
  requireDefaultQaTestFileImplementation,
};
