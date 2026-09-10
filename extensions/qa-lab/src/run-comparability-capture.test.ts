import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startQaLabServer } from "./lab-server.js";
import { mapQaSuiteWithConcurrency } from "./suite-planning.js";
import type { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import type { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

const { standard, isolated } = vi.hoisted(() => ({
  standard: vi.fn<typeof runQaFlowSuiteStandard>(),
  isolated: vi.fn<typeof runQaFlowSuiteIsolated>(),
}));
vi.mock("./suite-run-standard.js", () => ({ runQaFlowSuiteStandard: standard }));
vi.mock("./suite-run-isolated.js", () => ({ runQaFlowSuiteIsolated: isolated }));
vi.mock("./scenario-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-catalog.js")>()),
  readQaBootstrapScenarioCatalog: () => ({
    agentIdentityMarkdown: "QA fixture",
    kickoffTask: "Run check",
    scenarios: [makeQaSuiteTestScenario("check"), makeQaSuiteTestScenario("second-check")],
  }),
}));

describe("QA comparison capture at suite startup", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-capture-")));
    standard.mockReset().mockRejectedValue(new Error("reached suite dispatch"));
    isolated.mockReset().mockRejectedValue(new Error("reached suite dispatch"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("captures task conditions before dispatch without treating the selected runtime's implicit plugin as a task difference", async () => {
    for (const forcedRuntime of ["openclaw", "codex"] as const) {
      await expect(
        runQaFlowSuiteFromRuntime({
          repoRoot,
          forcedRuntime,
          concurrency: 1,
          providerMode: "mock-openai",
          primaryModel: "fixture/model",
          alternateModel: "fixture/model",
          startLab: startQaLabServer,
        }),
      ).rejects.toThrow("reached suite dispatch");
    }
    const first = standard.mock.calls[0]?.[1].comparisonIdentity;
    const second = standard.mock.calls[1]?.[1].comparisonIdentity;
    expect(first?.harness).toBe("openclaw");
    expect(second?.harness).toBe("codex");
    expect(first?.taskDigest).toBe(second?.taskDigest);
    expect(first?.runProfileDigest).toBe(second?.runProfileDigest);
  });

  it("does not claim source-bound conditions for a custom SUT command", async () => {
    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        concurrency: 1,
        providerMode: "mock-openai",
        sutOpenClawCommand: { executablePath: "/external/fixture" },
      }),
    ).rejects.toThrow("reached suite dispatch");
    expect(standard.mock.calls[0]?.[1].comparisonIdentity).toBeUndefined();
  });

  it("does not claim source-bound conditions for an injected lab launcher", async () => {
    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        concurrency: 1,
        providerMode: "mock-openai",
        startLab: (options) => startQaLabServer(options),
      }),
    ).rejects.toThrow("reached suite dispatch");
    expect(standard.mock.calls[0]?.[1].comparisonIdentity).toBeUndefined();
  });

  it("binds the effective readiness timeout and passes that captured value to execution", async () => {
    for (const timeout of ["120000", "240000"]) {
      vi.stubEnv("OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS", timeout);
      await expect(
        runQaFlowSuiteFromRuntime({ repoRoot, concurrency: 1, providerMode: "mock-openai" }),
      ).rejects.toThrow("reached suite dispatch");
    }
    const [first, second] = standard.mock.calls;
    expect(first?.[0]?.transportReadyTimeoutMs).toBe(120000);
    expect(second?.[0]?.transportReadyTimeoutMs).toBe(240000);
    expect(first?.[1].comparisonIdentity?.runProfileDigest).not.toBe(
      second?.[1].comparisonIdentity?.runProfileDigest,
    );
  });

  it.each([
    [0, 0.5, 0],
    [0, -1, 0],
    [25, 25.9, 25],
  ])(
    "captures equivalent staggers %s and %s as the same effective delay",
    async (first, second, effective) => {
      for (const workerStartStaggerMs of [first, second]) {
        await expect(
          runQaFlowSuiteFromRuntime({
            repoRoot,
            concurrency: 2,
            providerMode: "mock-openai",
            workerStartStaggerMs,
          }),
        ).rejects.toThrow("reached suite dispatch");
      }
      const identities = [];
      for (const [params, context] of isolated.mock.calls) {
        expect(params?.workerStartStaggerMs).toBe(effective);
        identities.push(context.comparisonIdentity?.runProfileDigest);
        const sleepImpl = vi.fn().mockResolvedValue(undefined);
        expect(
          await mapQaSuiteWithConcurrency([1, 2], 2, async (item) => item, {
            startStaggerMs: params?.workerStartStaggerMs,
            sleepImpl,
          }),
        ).toEqual([1, 2]);
        expect(sleepImpl.mock.calls).toEqual(effective > 0 ? [[effective]] : []);
      }
      expect(identities).toHaveLength(2);
      expect(identities[0]).toEqual(expect.any(String));
      expect(identities[0]).toBe(identities[1]);
    },
  );
});
