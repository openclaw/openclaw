import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as commandRuntime from "openclaw/plugin-sdk/run-command";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readQaJsonBody } from "./bus-server.js";
import { QaSuiteCleanupError } from "./errors.js";
import { startQaLabServer, type QaLabScenarioRun, type QaLabServerHandle } from "./lab-server.js";

const mocks = vi.hoisted(() => ({
  runSuite: vi.fn(),
  runScenario: vi.fn(),
  gatewayStopped: vi.fn(),
  loadModels: vi.fn(),
  acquireCapture: vi.fn(),
  releaseCapture: vi.fn(),
}));

vi.mock("./suite-launch.runtime.js", () => ({ runQaSuite: mocks.runSuite }));
vi.mock("./scenario.js", () => ({ runQaScenario: mocks.runScenario }));
vi.mock("./model-catalog.runtime.js", () => ({ loadQaRunnerModelOptions: mocks.loadModels }));
vi.mock("./bus-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bus-server.js")>();
  return { ...actual, readQaJsonBody: vi.fn(actual.readQaJsonBody) };
});
vi.mock("openclaw/plugin-sdk/qa-channel", () => ({
  qaChannelPlugin: {
    config: {
      resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId }),
    },
    gateway: {
      startAccount: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
          } else {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        await mocks.gatewayStopped();
      },
    },
  },
  setQaChannelRuntime: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  resolveDebugProxySettings: () => ({ proxyUrl: "" }),
  acquireDebugProxyCaptureStore: mocks.acquireCapture,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const labs: QaLabServerHandle[] = [];
const suiteInput = {
  channelDriver: "qa-channel",
  providerMode: "mock-openai",
  scenarioIds: ["dm-chat-baseline"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runSuite.mockReset();
  mocks.runScenario.mockResolvedValue({
    name: "Synthetic Slack-class roundtrip",
    status: "pass",
    steps: [{ name: "roundtrip", status: "pass" }],
  });
  mocks.gatewayStopped.mockReset();
  mocks.releaseCapture.mockReset();
  mocks.loadModels.mockResolvedValue([]);
  mocks.acquireCapture.mockReturnValue({
    store: { listSessions: () => [] },
    release: mocks.releaseCapture,
  });
});

afterEach(async () => {
  await Promise.allSettled(labs.splice(0).map((lab) => lab.stop()));
  vi.restoreAllMocks();
});

async function startLab() {
  const repoRoot = tempDirs.make("qa-lab-lifecycle-");
  const outputPath = path.join(repoRoot, "self-check.md");
  const lab = await startQaLabServer({ repoRoot, outputPath });
  labs.push(lab);
  return { lab, repoRoot, outputPath };
}

async function post(lab: QaLabServerHandle, route: string, body?: unknown) {
  return await fetch(`${lab.listenUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function outcomes(lab: QaLabServerHandle): Promise<QaLabScenarioRun | null> {
  const response = await fetch(`${lab.listenUrl}/api/outcomes`);
  const payload = (await response.json()) as { run: QaLabScenarioRun | null };
  return payload.run;
}

function holdReportWrite(outputPath: string) {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (file === outputPath) {
      entered.resolve();
      await release.promise;
    }
    await writeFile(file, data, options);
  });
  return { entered, release };
}

describe("QA Lab accepted-run lifecycle", () => {
  it("drains the accepted suite and its summary read before releasing shared resources", async () => {
    const { lab, repoRoot } = await startLab();
    const suiteEntered = createDeferred<void>();
    const finishSuite = createDeferred<void>();
    const summaryEntered = createDeferred<void>();
    const finishSummary = createDeferred<void>();
    const gatewayStopping = createDeferred<void>();
    const finishGateway = createDeferred<void>();
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        run: { status: "completed" },
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ name: "Channel chat baseline", status: "pass", steps: [] }],
      }),
    );
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (file === summaryPath) {
        summaryEntered.resolve();
        await finishSummary.promise;
      }
      return await readFile(file, options);
    });
    mocks.gatewayStopped.mockImplementation(async () => {
      gatewayStopping.resolve();
      await finishGateway.promise;
    });
    mocks.runSuite.mockImplementation(async ({ lab: suppliedLab }) => {
      expect(suppliedLab).toBe(lab);
      suiteEntered.resolve();
      await finishSuite.promise;
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        scenarios: [{ id: "dm-chat-baseline", name: "Channel chat baseline", status: "pass" }],
      });
      return {
        result: {
          outputDir: repoRoot,
          evidencePath: path.join(repoRoot, "qa-evidence.json"),
          reportPath: path.join(repoRoot, "qa-suite-report.md"),
          report: "# Completed suite\n",
          summaryPath,
        },
      };
    });
    await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
    const reset = vi.spyOn(lab.state, "reset");
    try {
      const response = await post(lab, "/api/scenario/suite", suiteInput);
      expect(response.status).toBe(202);
      await response.json();
      await suiteEntered.promise;
      expect(reset).toHaveBeenCalledOnce();

      const stopping = lab.stop();
      expect(lab.stop()).toBe(stopping);
      await outcomes(lab);
      expect(mocks.gatewayStopped).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledOnce();

      finishSuite.resolve();
      await summaryEntered.promise;
      await outcomes(lab);
      expect(mocks.gatewayStopped).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();

      finishSummary.resolve();
      await gatewayStopping.promise;
      expect(await outcomes(lab)).toMatchObject({
        status: "completed",
        counts: { passed: 1 },
      });
      const bootstrap = await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json();
      expect(bootstrap).toMatchObject({
        runner: { status: "completed" },
        latestReport: { markdown: "# Completed suite\n" },
      });
      expect(mocks.loadModels).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();

      finishGateway.resolve();
      await stopping;
      expect(lab.stop()).toBe(stopping);
      await lab.stop();
      expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
      expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenLastCalledWith(true);
    } finally {
      finishSuite.resolve();
      finishSummary.resolve();
      finishGateway.resolve();
    }
  });

  it.each(["direct", "http"] as const)(
    "drains a %s self-check through report publication and rejects overlapping runs",
    async (entrypoint) => {
      const { lab, outputPath } = await startLab();
      const write = holdReportWrite(outputPath);
      const gatewayStopping = createDeferred<void>();
      const finishGateway = createDeferred<void>();
      mocks.gatewayStopped.mockImplementation(async () => {
        gatewayStopping.resolve();
        await finishGateway.promise;
      });
      const run =
        entrypoint === "direct"
          ? lab.runSelfCheck()
          : post(lab, "/api/scenario/self-check").then(async (response) => {
              expect(response.status).toBe(200);
              return await response.json();
            });
      const settled = run.catch((error: unknown) => error);
      try {
        await write.entered.promise;
        const running = await outcomes(lab);
        expect(running).toMatchObject({ status: "running", counts: { running: 1 } });
        for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
          const response = await post(lab, route, suiteInput);
          expect(response.status).toBe(409);
          await response.json();
        }
        await expect(lab.runSelfCheck()).rejects.toThrow("QA run already in progress");
        expect(await outcomes(lab)).toEqual(running);
        expect(mocks.runScenario).toHaveBeenCalledOnce();
        expect(mocks.runSuite).not.toHaveBeenCalled();

        const stopping = lab.stop();
        await outcomes(lab);
        expect(mocks.gatewayStopped).not.toHaveBeenCalled();
        write.release.resolve();
        const result = await settled;
        expect(result).toMatchObject({ outputPath });
        expect(await fs.readFile(outputPath, "utf8")).toContain("Synthetic Slack-class roundtrip");
        await gatewayStopping.promise;
        expect(await outcomes(lab)).toMatchObject({
          status: "completed",
          startedAt: running?.startedAt,
          counts: { passed: 1, failed: 0, running: 0 },
        });
        const report = await (await fetch(`${lab.listenUrl}/api/report`)).json();
        expect(report).toMatchObject({ report: { outputPath } });
        finishGateway.resolve();
        await stopping;
      } finally {
        write.release.resolve();
        finishGateway.resolve();
        await settled;
      }
    },
  );

  it.each(["direct", "http"] as const)(
    "cancels a %s self-check before joining unwind and report publication",
    async (entrypoint) => {
      const { lab, outputPath } = await startLab();
      const entered = createDeferred<void>();
      const cancelled = createDeferred<void>();
      const unwind = createDeferred<void>();
      const write = holdReportWrite(outputPath);
      const gatewayStopping = createDeferred<void>();
      const finishGateway = createDeferred<void>();
      mocks.runScenario.mockImplementation(
        async (_scenario: unknown, { signal }: { signal: AbortSignal }) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          entered.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          cancelled.resolve();
          await unwind.promise;
          return {
            name: "Cancelled self-check",
            status: "fail",
            details: String(signal.reason),
            steps: [{ name: "held action", status: "fail", details: String(signal.reason) }],
          };
        },
      );
      mocks.gatewayStopped.mockImplementation(async () => {
        gatewayStopping.resolve();
        await finishGateway.promise;
      });
      await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
      const run =
        entrypoint === "direct"
          ? lab.runSelfCheck()
          : post(lab, "/api/scenario/self-check").then(async (response) => {
              expect(response.status).toBe(200);
              return await response.json();
            });
      const settled = run.catch((error: unknown) => error);
      try {
        await entered.promise;
        const stopping = lab.stop();
        expect(lab.stop()).toBe(stopping);
        await cancelled.promise;
        expect(await outcomes(lab)).toMatchObject({ status: "running" });
        expect(mocks.gatewayStopped).not.toHaveBeenCalled();
        expect(mocks.releaseCapture).not.toHaveBeenCalled();

        unwind.resolve();
        await write.entered.promise;
        expect(mocks.gatewayStopped).not.toHaveBeenCalled();
        expect(mocks.releaseCapture).not.toHaveBeenCalled();
        write.release.resolve();
        const result = await settled;
        const report = await fs.readFile(outputPath, "utf8");
        const cancellation = expect.stringContaining("QA Lab run cancelled during shutdown");
        expect(result).toMatchObject({
          outputPath,
          report,
          checks: [{ name: "QA self-check scenario", status: "fail", details: "0/1 steps passed" }],
          [entrypoint === "direct" ? "scenarioResult" : "scenario"]: {
            name: "Cancelled self-check",
            status: "fail",
            details: cancellation,
            steps: [{ name: "held action", status: "fail", details: cancellation }],
          },
        });
        expect(report).toContain("QA Lab run cancelled during shutdown");
        await gatewayStopping.promise;
        expect(await outcomes(lab)).toMatchObject({
          status: "completed",
          counts: { failed: 1, passed: 0, running: 0 },
        });
        finishGateway.resolve();
        await stopping;
        expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
        expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      } finally {
        const stopping = lab.stop();
        unwind.resolve();
        write.release.resolve();
        finishGateway.resolve();
        await Promise.allSettled([settled, stopping]);
      }
    },
  );

  it("records a suite cancellation before closing the Lab gateway", async () => {
    const { lab } = await startLab();
    const entered = createDeferred<void>();
    const gatewayStopping = createDeferred<void>();
    const finishGateway = createDeferred<void>();
    mocks.runSuite.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
    });
    mocks.gatewayStopped.mockImplementation(async () => {
      gatewayStopping.resolve();
      await finishGateway.promise;
    });
    try {
      const response = await post(lab, "/api/scenario/suite", suiteInput);
      expect(response.status).toBe(202);
      await response.json();
      await entered.promise;
      const stopping = lab.stop();
      await gatewayStopping.promise;
      expect(await outcomes(lab)).toMatchObject({
        status: "completed",
        counts: { failed: 1, passed: 0, running: 0 },
        scenarios: [
          { status: "fail", details: expect.stringContaining("cancelled during shutdown") },
        ],
      });
      finishGateway.resolve();
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      finishGateway.resolve();
      await lab.stop();
    }
  });

  it.each(["direct", "http"] as const)(
    "records a failed %s self-check when report publication rejects",
    async (entrypoint) => {
      const { lab, outputPath } = await startLab();
      const write = holdReportWrite(outputPath);
      const failure = new Error("self-check report write failed");
      const run =
        entrypoint === "direct"
          ? lab.runSelfCheck()
          : post(lab, "/api/scenario/self-check").then(async (response) => {
              expect(response.status).toBe(500);
              return await response.json();
            });
      const settled = run.catch((error: unknown) => error);
      try {
        await write.entered.promise;
        const running = await outcomes(lab);
        write.release.reject(failure);
        const result = await settled;
        if (entrypoint === "direct") {
          expect(result).toBe(failure);
        } else {
          expect(result).toEqual({ error: failure.message });
        }
        expect(await outcomes(lab)).toMatchObject({
          kind: "self-check",
          status: "completed",
          startedAt: running?.startedAt,
          finishedAt: expect.any(String),
          counts: { total: 1, failed: 1, passed: 0, running: 0 },
          scenarios: [{ status: "fail", details: failure.message }],
        });
        expect(await (await fetch(`${lab.listenUrl}/api/report`)).json()).toEqual({ report: null });
        vi.mocked(fs.writeFile).mockRestore();
        const reset = await post(lab, "/api/reset");
        expect(reset.status).toBe(200);
        await reset.json();
        await expect(lab.runSelfCheck()).resolves.toMatchObject({ outputPath });
        // A failure already delivered to its caller is not replayed by a later stop.
        await expect(lab.stop()).resolves.toBeUndefined();
      } finally {
        write.release.resolve();
        await settled;
      }
    },
  );

  it.each([
    ["before", false],
    ["during", false],
    ["before", true],
    ["during", true],
  ] as const)("retains fatal cleanup %s stop, combined=%s", async (timing, combined) => {
    const { lab, repoRoot } = await startLab();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    const fatal = new QaSuiteCleanupError([new Error("child still alive")], "cleanup unconfirmed");
    const gatewayError = new Error("gateway stop failed");
    const captureError = new Error("capture release failed");
    const report = {
      outputPath: path.join(repoRoot, "report.md"),
      markdown: "# Done",
      generatedAt: new Date(0).toISOString(),
    };
    const reset = vi.spyOn(lab.state, "reset");
    if (combined) {
      mocks.gatewayStopped.mockRejectedValue(gatewayError);
      mocks.releaseCapture.mockImplementation(() => {
        throw captureError;
      });
    }
    mocks.runSuite.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      lab.setLatestReport(report);
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        scenarios: [{ id: "dm-chat-baseline", name: "Completed scenario", status: "pass" }],
      });
      throw fatal;
    });
    try {
      await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
      const response = await post(lab, "/api/scenario/suite", suiteInput);
      expect(response.status).toBe(202);
      await response.json();
      await entered.promise;
      const earlierStop = timing === "during" ? lab.stop() : undefined;
      finish.resolve();
      if (!earlierStop) {
        const completed = await outcomes(lab);
        expect(completed).toMatchObject({ status: "completed", counts: { passed: 1 } });
        for (const route of ["/api/scenario/suite", "/api/scenario/self-check", "/api/reset"]) {
          const denied = await post(lab, route, suiteInput);
          expect(denied.status).toBe(503);
          expect(await denied.json()).toMatchObject({
            error: expect.stringContaining("restart QA Lab"),
          });
        }
        await expect(lab.runSelfCheck()).rejects.toThrow("restart QA Lab");
        expect(await outcomes(lab)).toEqual(completed);
        expect(await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json()).toMatchObject({
          latestReport: report,
          runner: { status: "failed" },
        });
        expect(reset).toHaveBeenCalledOnce();
        expect(mocks.runSuite).toHaveBeenCalledOnce();
        expect(mocks.runScenario).not.toHaveBeenCalled();
      }
      const stopping = earlierStop ?? lab.stop();
      const observed = stopping.catch((error: unknown) => error);
      expect(lab.stop()).toBe(stopping);
      const error = await observed;
      if (combined) {
        if (!(error instanceof QaSuiteCleanupError)) {
          throw new Error("expected fatal cleanup marker", { cause: error });
        }
        expect(error.errors).toHaveLength(3);
        for (const [index, original] of [fatal, gatewayError, captureError].entries()) {
          expect(error.errors[index]).toBe(original);
        }
        expect(error.cause).toBe(fatal);
      } else {
        expect(error).toBe(fatal);
      }
      expect(lab.stop()).toBe(stopping);
      await expect(lab.stop()).rejects.toBe(error);
      expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
      expect(mocks.releaseCapture).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
    }
  });

  it.each(["before", "during"] as const)(
    "retains native preparation cleanup failure %s stop",
    async (timing) => {
      const { runQaSuite } = await vi.importActual<typeof import("./suite-launch.runtime.js")>(
        "./suite-launch.runtime.js",
      );
      const { lab } = await startLab();
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const settled = createDeferred<unknown>();
      const failure = new Error("native preparation process cleanup unconfirmed");
      vi.spyOn(commandRuntime, "runPluginCommandWithTimeout").mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "",
      });
      vi.spyOn(processRuntime, "withCommandProcessScope").mockImplementationOnce(async (run) => {
        await run(() => {});
        entered.resolve();
        await finish.promise;
        throw failure;
      });
      mocks.runSuite.mockImplementation(async (params) => {
        try {
          const result = await runQaSuite(params);
          settled.resolve(result);
          return result;
        } catch (error) {
          settled.resolve(error);
          throw error;
        }
      });
      const published = vi.spyOn(lab, "setLatestReport");
      const reset = vi.spyOn(lab.state, "reset");
      let stopping: Promise<void> | undefined;
      let stopped: Promise<unknown> | undefined;
      try {
        await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
        const accepted = await post(lab, "/api/scenario/suite", {
          ...suiteInput,
          scenarioIds: ["dm-chat-baseline", "auth-profile-doctor-migration-safety"],
        });
        expect(accepted.status).toBe(202);
        await accepted.json();
        await entered.promise;
        if (timing === "during") {
          stopping = lab.stop();
          stopped = stopping.catch((error: unknown) => error);
        }
        finish.resolve();
        const terminal = await settled.promise;
        expect(terminal).toBeInstanceOf(QaSuiteCleanupError);
        expect(terminal).toMatchObject({
          cause: expect.objectContaining({ cause: failure, errors: [failure] }),
        });
        expect(published).toHaveBeenCalledOnce();
        const report = published.mock.calls[0]?.[0];
        if (!report) {
          throw new Error("expected failed preparation report");
        }
        expect(await fs.readFile(report.outputPath, "utf8")).toContain(failure.message);
        if (timing === "before") {
          const completed = await outcomes(lab);
          expect(completed).toMatchObject({
            status: "completed",
            counts: { total: 2, failed: 2, passed: 0, running: 0 },
          });
          for (const route of ["/api/scenario/suite", "/api/scenario/self-check", "/api/reset"]) {
            const denied = await post(lab, route, suiteInput);
            expect(denied.status).toBe(503);
            expect(await denied.json()).toMatchObject({
              error: expect.stringContaining("restart QA Lab"),
            });
          }
          await expect(lab.runSelfCheck()).rejects.toThrow("restart QA Lab");
          expect(await outcomes(lab)).toEqual(completed);
          expect(await (await fetch(`${lab.listenUrl}/api/report`)).json()).toEqual({ report });
          expect(reset).toHaveBeenCalledOnce();
          expect(mocks.runSuite).toHaveBeenCalledOnce();
          stopping = lab.stop();
          stopped = stopping.catch((error: unknown) => error);
        }
        expect(lab.stop()).toBe(stopping);
        expect(await stopped).toBe(terminal);
        await expect(lab.stop()).rejects.toBe(terminal);
        expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
        expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        await Promise.allSettled([stopping ?? lab.stop()]);
      }
    },
  );

  it("fences a held suite body after another run reports unconfirmed cleanup", async () => {
    const { lab } = await startLab();
    const bodyEntered = createDeferred<void>();
    const finishBody = createDeferred<void>();
    const runEntered = createDeferred<void>();
    const readBody = vi.mocked(readQaJsonBody).getMockImplementation();
    if (!readBody) {
      throw new Error("expected real request body implementation");
    }
    vi.mocked(readQaJsonBody).mockImplementationOnce(async (...args) => {
      bodyEntered.resolve();
      await finishBody.promise;
      return await readBody(...args);
    });
    const fatal = new QaSuiteCleanupError([new Error("child still alive")], "cleanup unconfirmed");
    mocks.runSuite.mockImplementation(async () => {
      runEntered.resolve();
      throw fatal;
    });
    const reset = vi.spyOn(lab.state, "reset");
    const pending = post(lab, "/api/scenario/suite", suiteInput);
    try {
      await bodyEntered.promise;
      const accepted = await post(lab, "/api/scenario/suite", suiteInput);
      expect(accepted.status).toBe(202);
      await accepted.json();
      await runEntered.promise;
      const completed = await outcomes(lab);
      expect(completed).toMatchObject({ status: "completed", counts: { failed: 1 } });
      finishBody.resolve();
      const denied = await pending;
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({
        error: expect.stringContaining("restart QA Lab"),
      });
      expect(await outcomes(lab)).toEqual(completed);
      expect(reset).toHaveBeenCalledOnce();
      expect(mocks.runSuite).toHaveBeenCalledOnce();
      await expect(lab.stop()).rejects.toBe(fatal);
    } finally {
      finishBody.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("fences requests awaiting their suite body without resetting or launching work", async () => {
    const { lab } = await startLab();
    const bodyEntered = createDeferred<void>();
    const finishBody = createDeferred<void>();
    const gatewayStopping = createDeferred<void>();
    const finishGateway = createDeferred<void>();
    const readBody = vi.mocked(readQaJsonBody).getMockImplementation()!;
    vi.mocked(readQaJsonBody).mockImplementationOnce(async (...args) => {
      bodyEntered.resolve();
      await finishBody.promise;
      return await readBody(...args);
    });
    mocks.gatewayStopped.mockImplementation(async () => {
      gatewayStopping.resolve();
      await finishGateway.promise;
    });
    lab.state.addInboundMessage({
      conversation: { id: "retained", kind: "direct" },
      senderId: "operator",
      text: "accepted state",
    });
    const snapshot = lab.state.getSnapshot();
    const reset = vi.spyOn(lab.state, "reset");
    const pending = post(lab, "/api/scenario/suite", suiteInput);
    try {
      await bodyEntered.promise;
      const stopping = lab.stop();
      await gatewayStopping.promise;
      finishBody.resolve();
      const response = await pending;
      expect(response.status).toBe(503);
      await response.json();
      await expect(lab.runSelfCheck()).rejects.toThrow("QA Lab is stopping");
      for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
        const rejected = await post(lab, route, suiteInput);
        expect(rejected.status).toBe(503);
        await rejected.json();
      }
      const capture = await fetch(`${lab.listenUrl}/api/capture/sessions`);
      expect(capture.status).toBe(503);
      await capture.json();
      await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json();
      expect(mocks.loadModels).not.toHaveBeenCalled();
      expect(mocks.acquireCapture).not.toHaveBeenCalled();
      expect(mocks.runSuite).not.toHaveBeenCalled();
      expect(mocks.runScenario).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(lab.state.getSnapshot()).toEqual(snapshot);
      finishGateway.resolve();
      await stopping;
    } finally {
      finishBody.resolve();
      finishGateway.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("preserves the accepted failure and every cleanup failure in one cached stop", async () => {
    const { lab, outputPath } = await startLab();
    const write = holdReportWrite(outputPath);
    const runError = new Error("self-check write failed");
    const gatewayError = new Error("gateway stop failed");
    const captureError = new Error("capture release failed");
    mocks.gatewayStopped.mockRejectedValue(gatewayError);
    mocks.releaseCapture.mockImplementation(() => {
      throw captureError;
    });
    await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
    const run = lab.runSelfCheck().catch((error: unknown) => error);
    try {
      await write.entered.promise;
      const stopping = lab.stop();
      const stopped = stopping.catch((error: unknown) => error);
      expect(lab.stop()).toBe(stopping);
      await outcomes(lab);
      write.release.reject(runError);
      expect(await run).toBe(runError);
      const error = await stopped;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        cause: runError,
        errors: [runError, gatewayError, captureError],
      });
      expect(lab.stop()).toBe(stopping);
      await expect(lab.stop()).rejects.toBe(error);
      expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
      expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      await expect(fetch(`${lab.listenUrl}/healthz`)).rejects.toThrow();
    } finally {
      write.release.resolve();
      await run;
    }
  });
});
