import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { QaSuiteArtifactError, QaSuiteCleanupError, QaSuiteInfraError } from "./errors.js";
import {
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import * as qaTransportRegistry from "./qa-transport-registry.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaSuiteWithInfraRetry } from "./suite-infra-retry.js";
import { runQaSuite } from "./suite-launch.runtime.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunParams } from "./suite.js";
import {
  createQaSuiteTransportAdapter,
  runQaFlowSuiteCleanupPlan,
  throwQaSuiteCleanupErrors,
} from "./suite.js";

// Register shared mocks before SUT imports, independently of import sorting.
const {
  createDeferred,
  makeTempRepo,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  requireDefaultQaTestFileImplementation,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = await vi.hoisted(async () => await import("./suite-launch.runtime.test-support.js"));

describe("qa suite runtime launcher", () => {
  it("does not retry a cleanup-only ECONNRESET through its preserved cause", async () => {
    const cleanupError = Object.assign(new Error("cleanup socket reset"), {
      code: "ECONNRESET",
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let attempts = 0;

    try {
      const result = runQaSuiteWithInfraRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
          throwQaSuiteCleanupErrors({
            cleanupFailures: [{ phase: "lab stop", error: cleanupError }],
            runFailed: false,
            runError: undefined,
          });
        }
        return "retried";
      }, 1);

      await expect(result).rejects.toBeInstanceOf(QaSuiteCleanupError);
      await expect(result).rejects.toMatchObject({ cause: cleanupError });
      expect(attempts).toBe(1);
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it.each([false, true])(
    "retries a settled primary error only after the entire cleanup plan succeeds (provider failure: %s)",
    async (providerFailure) => {
      const primary = new QaSuiteInfraError("gateway_startup_unhealthy", "child failed", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      });
      const cleanupError = new Error("provider stop failed");
      const finishLab = vi.fn(async () => {});
      const run = vi.fn(async () => {
        const cleanupFailures = await runQaFlowSuiteCleanupPlan({
          cleanupTransportBeforeGatewayStop: async () => {},
          cleanupTransportAfterGatewayStop: async () => {},
          stopGateway: async () => ({
            process: "confirmed-stopped",
            errors: [primary],
            settledRunError: primary,
          }),
          disposeAgentHarnesses: async () => {},
          stopProvider: async () => {
            if (providerFailure) {
              throw cleanupError;
            }
          },
          finishLab,
        });
        throwQaSuiteCleanupErrors({ cleanupFailures, runFailed: false, runError: undefined });
      });
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const outcome = runQaSuiteWithInfraRetry(run, 1);
        if (providerFailure) {
          await expect(outcome).rejects.toBeInstanceOf(QaSuiteCleanupError);
          await expect(outcome).rejects.toMatchObject({
            cause: primary,
            errors: [primary, cleanupError],
          });
          expect(run).toHaveBeenCalledTimes(1);
        } else {
          await expect(outcome).rejects.toBe(primary);
          expect(run).toHaveBeenCalledTimes(2);
        }
        expect(finishLab).toHaveBeenCalledTimes(run.mock.calls.length);
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it.each([
    ...["plain", "infra", "publication_failed", "summary_missing"].flatMap((primaryKind) =>
      [false, true].flatMap((sameDiagnostic) =>
        [false, true].map((providerFailure) => ({ primaryKind, sameDiagnostic, providerFailure })),
      ),
    ),
    { primaryKind: "nested network", sameDiagnostic: false, providerFailure: false },
    { primaryKind: "cleanup", sameDiagnostic: false, providerFailure: false },
  ])(
    "retains primary policy and Gateway diagnostics ($primaryKind, same=$sameDiagnostic, cleanup=$providerFailure)",
    async ({ primaryKind, sameDiagnostic, providerFailure }) => {
      const primary =
        primaryKind === "infra"
          ? new QaSuiteInfraError("gateway_startup_unhealthy", "primary infrastructure failed")
          : primaryKind === "publication_failed" || primaryKind === "summary_missing"
            ? new QaSuiteArtifactError(primaryKind, "primary artifact failed")
            : primaryKind === "cleanup"
              ? new QaSuiteCleanupError([], "primary cleanup failed")
              : primaryKind === "nested network"
                ? new Error("primary network failed", {
                    cause: new Error("network level one", {
                      cause: new Error("network level two", {
                        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
                      }),
                    }),
                  })
                : new Error("primary ordinary failure");
      const gateway = sameDiagnostic
        ? primary
        : new QaSuiteInfraError("gateway_startup_unhealthy", "distinct Gateway diagnostic");
      const cleanup = new Error("provider release failed");
      const originalDescriptors = Object.getOwnPropertyDescriptors(primary);
      const phases: string[] = [];
      const published = vi.fn();
      const run = vi.fn(async () => {
        const cleanupFailures = await runQaFlowSuiteCleanupPlan({
          cleanupTransportBeforeGatewayStop: async () => {
            phases.push("before");
          },
          stopGateway: async () => {
            phases.push("gateway");
            return { process: "confirmed-stopped", errors: [gateway], settledRunError: gateway };
          },
          cleanupTransportAfterGatewayStop: async () => {
            phases.push("after");
          },
          disposeAgentHarnesses: async () => {
            phases.push("agents");
          },
          stopProvider: async () => {
            phases.push("provider");
            if (providerFailure) {
              throw cleanup;
            }
          },
          finishLab: async () => {
            phases.push("lab");
          },
        });
        throwQaSuiteCleanupErrors({ cleanupFailures, runFailed: true, runError: primary });
        published();
      });
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const failure: unknown = await runQaSuiteWithInfraRetry(run, 1).catch(
          (error: unknown) => error,
        );
        const expectedRunErrors = sameDiagnostic ? [primary] : [primary, gateway];
        if (providerFailure) {
          expect(failure).toBeInstanceOf(QaSuiteCleanupError);
          expect(failure).toMatchObject({ cause: primary });
        } else if (sameDiagnostic) {
          expect(failure).toBe(primary);
        } else {
          expect(failure).toBeInstanceOf(primary.constructor);
          if (primary instanceof QaSuiteArtifactError || primary instanceof QaSuiteInfraError) {
            expect(failure).toMatchObject({ code: primary.code });
          }
          if (!(primary instanceof QaSuiteCleanupError)) {
            expect(failure).not.toBeInstanceOf(QaSuiteCleanupError);
          }
        }
        if (providerFailure || !sameDiagnostic) {
          const aggregate =
            failure instanceof AggregateError
              ? failure
              : failure instanceof Error && failure.cause instanceof AggregateError
                ? failure.cause
                : undefined;
          expect(aggregate).toBeInstanceOf(AggregateError);
          const errors = providerFailure ? [...expectedRunErrors, cleanup] : expectedRunErrors;
          expect(aggregate?.errors).toHaveLength(errors.length);
          for (const [index, error] of errors.entries()) {
            expect(aggregate?.errors[index]).toBe(error);
            expect(formatErrorMessage(failure)).toContain(error.message);
          }
          expect(aggregate?.cause).toBe(primary);
        }
        const retries =
          !providerFailure && ["infra", "summary_missing", "nested network"].includes(primaryKind);
        expect(run).toHaveBeenCalledTimes(retries ? 2 : 1);
        expect(phases).toEqual(
          Array.from({ length: run.mock.calls.length }, () => [
            "before",
            "gateway",
            "after",
            "agents",
            "provider",
            "lab",
          ]).flat(),
        );
        expect(published).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptors(primary)).toEqual(originalDescriptors);
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it.each(["publication_failed", "summary_missing"] as const)(
    "distinguishes terminal publication from recoverable %s artifacts",
    async (code) => {
      const cause = Object.assign(new Error("artifact socket reset"), { code: "ECONNRESET" });
      const failure = new QaSuiteArtifactError(code, "artifact unavailable", { cause });
      const run = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("retried");
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        if (code === "publication_failed") {
          await expect(runQaSuiteWithInfraRetry(run, 1)).rejects.toBe(failure);
          expect(run).toHaveBeenCalledTimes(1);
          expect(stderrWrite).not.toHaveBeenCalled();
        } else {
          await expect(runQaSuiteWithInfraRetry(run, 1)).resolves.toBe("retried");
          expect(run).toHaveBeenCalledTimes(2);
        }
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it.each(["write", "report", "summary", "evidence"] as const)(
    "withholds aggregate completion after child artifact %s publication fails",
    async (failureKind) => {
      const repoRoot = await makeTempRepo("qa-suite-child-publication-");
      const outputDir = path.join(repoRoot, "out");
      const failure = Object.assign(new Error("child report publication failed"), { code: "EIO" });
      const actualSecurity = await vi.importActual<
        typeof import("openclaw/plugin-sdk/security-runtime")
      >("openclaw/plugin-sdk/security-runtime");
      let publicationAttempts = 0;
      let verificationPath: string | undefined;
      let verificationCause: unknown;
      const access = fs.access;
      const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (filePath, mode) => {
        if (filePath === verificationPath) {
          // Remove the real published file only at its postwrite verification boundary.
          expect((await fs.stat(filePath)).isFile()).toBe(true);
          await fs.rm(filePath);
        }
        try {
          return await access(filePath, mode);
        } catch (error) {
          if (filePath === verificationPath) {
            verificationCause = error;
          }
          throw error;
        }
      });
      replaceFileAtomicMock.mockImplementation(async (options) => {
        if (options.filePath.includes(`${path.sep}flow${path.sep}`)) {
          publicationAttempts += 1;
          if (failureKind === "write") {
            throw failure;
          }
        }
        return await actualSecurity.replaceFileAtomic(options);
      });
      runQaFlowSuite.mockImplementationOnce(async (params) => {
        if (failureKind !== "write") {
          const filename =
            failureKind === "report"
              ? "qa-suite-report.md"
              : failureKind === "summary"
                ? "qa-suite-summary.json"
                : "qa-evidence.json";
          verificationPath = path.join(params.outputDir, filename);
        }
        await writeQaSuiteArtifacts({
          outputDir: params.outputDir,
          startedAt: new Date(),
          finishedAt: new Date(),
          scenarios: [{ name: "child passed", status: "pass", steps: [] }],
          scenarioDefinitions: [makeQaSuiteTestScenario("dm-chat-baseline")],
          transport: {
            id: "qa-channel",
            createReportNotes: () => [],
          } as unknown as QaTransportAdapter,
          providerMode: "mock-openai",
          primaryModel: "mock-openai/test",
          alternateModel: "mock-openai/alt",
          fastMode: true,
          concurrency: 1,
        });
        throw new Error("expected publication failure");
      });
      try {
        const result = runQaSuite({
          repoRoot,
          outputDir,
          scenarioIds: ["dm-chat-baseline", "control-ui-chat-flow-playwright"],
        });
        if (failureKind === "write") {
          await expect(result).rejects.toMatchObject({
            code: "publication_failed",
            cause: failure,
          });
        } else {
          const error: unknown = await result.catch((caughtError: unknown) => caughtError);
          expect(error).toBeInstanceOf(QaSuiteArtifactError);
          expect(error).toMatchObject({
            code: "publication_failed",
            cause: { code: `${failureKind}_missing`, cause: { code: "ENOENT" } },
          });
          if (
            !(error instanceof QaSuiteArtifactError) ||
            !(error.cause instanceof QaSuiteArtifactError)
          ) {
            throw new Error("expected the original artifact verification failure");
          }
          expect(error.cause.cause).toBe(verificationCause);
        }
        expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
        expect(publicationAttempts).toBe(failureKind === "write" ? 1 : 3);
        await expect(fs.stat(path.join(outputDir, "qa-suite-summary.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        accessSpy.mockRestore();
        replaceFileAtomicMock.mockImplementation(actualSecurity.replaceFileAtomic);
      }
    },
  );

  it("withholds aggregate completion after an immutable child occurrence write fails without retrying", async () => {
    const repoRoot = await makeTempRepo("qa-suite-occurrence-publication-");
    const outputDir = path.join(repoRoot, "out");
    const catalog = scenarioCatalog.readQaBootstrapScenarioCatalog();
    let retainedPath = "";
    let retainedBytes: Buffer | undefined;
    let retainedHash = "";
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const scenario = catalog.scenarios.find((item) => item.id === params.scenarioIds![0])!;
      const recording = await createQaSuiteEvidenceInvocation(params, {
        repoRoot,
        outputDir: params.outputDir!,
        selectedScenarios: [scenario],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/test",
        transportId: "qa-channel",
      });
      const completed = recording.invocation.begin(0);
      await recording.record(0, completed, { name: scenario.id, status: "pass", steps: [] });
      const receipt = recording.snapshot().occurrences.find((item) => item.id === completed)!
        .receipts[0]!;
      retainedPath = path.join(params.outputDir!, receipt.artifact.path);
      retainedBytes = await fs.readFile(retainedPath);
      retainedHash = receipt.artifact.sha256!;
      const unpublished = recording.invocation.begin(0);
      await fs.mkdir(
        path.join(params.outputDir!, "artifacts", "occurrences", `${unpublished}.json`),
      );
      await recording.record(0, unpublished, { name: scenario.id, status: "pass", steps: [] });
      throw new Error("expected immutable publication failure");
    });
    await expect(
      runQaSuite({
        repoRoot,
        outputDir,
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline", "control-ui-chat-flow-playwright"],
      }),
    ).rejects.toMatchObject({ code: "publication_failed", cause: expect.any(Error) });
    expect(runQaFlowSuite).toHaveBeenCalledOnce();
    const bytes = await fs.readFile(retainedPath);
    expect(bytes).toEqual(retainedBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(retainedHash);
    await expect(fs.stat(path.join(outputDir, "qa-suite-summary.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe.each(["flow/native", "parallel scripts"] as const)("%s fatal partitions", (route) => {
    it.each([
      "dual cleanup",
      "cleanup then publication",
      "publication then cleanup",
      "dual publication",
      "cleanup with successful sibling",
      "exhausted evidence then publication",
    ] as const)("drains and retains %s without further admission", async (mode) => {
      const repoRoot = await makeTempRepo("qa-suite-fatal-partitions-");
      const outputDir = path.join(repoRoot, "out");
      const expectedRetries = mode === "exhausted evidence then publication" ? 1 : 0;
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const first =
        expectedRetries || mode.startsWith("publication") || mode === "dual publication"
          ? new QaSuiteArtifactError(
              expectedRetries ? "evidence_missing" : "publication_failed",
              "first partition artifact failed",
            )
          : new QaSuiteCleanupError([new Error("first cleanup cause")], "first partition cleanup");
      const second =
        mode === "cleanup with successful sibling"
          ? undefined
          : mode === "dual cleanup" || mode === "publication then cleanup"
            ? new QaSuiteCleanupError(
                [new Error("second cleanup cause")],
                "second partition cleanup",
              )
            : new QaSuiteArtifactError("publication_failed", "second partition publication failed");
      const gates = [createDeferred(), createDeferred()] as const;
      const started = [createDeferred(), createDeferred()] as const;
      const firstRejected = createDeferred();
      const defaultNative = requireDefaultQaTestFileImplementation();
      let firstAttempts = 0;
      const failFirst = async () => {
        firstAttempts += 1;
        started[0].resolve();
        await gates[0].promise;
        firstRejected.resolve();
        throw first;
      };
      const finishSecond = async (params: Parameters<typeof defaultNative>[0]) => {
        started[1].resolve();
        await gates[1].promise;
        if (second) {
          throw second;
        }
        return await defaultNative(params);
      };
      let scenarioIds = [
        "dm-chat-baseline",
        "control-ui-chat-flow-playwright",
        "docker-npm-onboard-channel-agent",
      ];
      if (route === "parallel scripts") {
        const scenarios = ["first", "second", "pending"].map((id) => {
          const scenario = makeQaSuiteTestScenario(id);
          scenario.execution = { kind: "script", path: `scripts/${id}.mjs`, parallelSafe: true };
          return scenario;
        });
        vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
          agentIdentityMarkdown: "fixture",
          kickoffTask: "fixture",
          scenarios,
        });
        scenarioIds = scenarios.map((scenario) => scenario.id);
        runQaTestFileScenarios.mockImplementation(async (params) => {
          if (params.scenarios[0]?.id === "first") {
            return await failFirst();
          }
          if (params.scenarios[0]?.id === "second") {
            return await finishSecond(params);
          }
          throw new Error("pending script must not be admitted");
        });
      } else {
        runQaFlowSuite.mockImplementation(failFirst);
        runQaTestFileScenarios.mockImplementation(finishSecond);
      }
      let settled = false;
      const pending = runQaSuite({
        repoRoot,
        outputDir,
        concurrency: route === "parallel scripts" ? 2 : 8,
        scenarioIds,
      })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await Promise.all(started.map((entry) => entry.promise));
        gates[0].resolve();
        await firstRejected.promise;
        // Let the rejected partition reach the scheduler while its sibling stays owned.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(firstAttempts).toBe(1 + expectedRetries);
        expect(
          stderrWrite.mock.calls.filter(([line]) => String(line).includes("infra retry")),
        ).toHaveLength(expectedRetries);
        expect(runQaTestFileScenarios).toHaveBeenCalledTimes(
          route === "parallel scripts" ? 2 + expectedRetries : 1,
        );
        expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(outputDir, "qa-suite-summary.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        gates[1].resolve();
        const failure = await pending;
        if (!second) {
          expect(failure).toBe(first);
        } else {
          const cleanup =
            first instanceof QaSuiteCleanupError || second instanceof QaSuiteCleanupError;
          expect(failure).toBeInstanceOf(cleanup ? QaSuiteCleanupError : QaSuiteArtifactError);
          const aggregate = failure instanceof QaSuiteArtifactError ? failure.cause : failure;
          expect(aggregate).toBeInstanceOf(AggregateError);
          if (!(aggregate instanceof AggregateError)) {
            throw new Error("expected ordered partition failures");
          }
          expect(aggregate.errors).toHaveLength(2);
          expect(aggregate.errors[0]).toBe(first);
          expect(aggregate.errors[1]).toBe(second);
          expect(aggregate.cause).toBe(first);
          expect(formatErrorMessage(failure)).toContain(first.message);
          expect(formatErrorMessage(failure)).toContain(second.message);
          if (!cleanup) {
            expect(failure).toMatchObject({ code: "publication_failed" });
          }
        }
        expect(runQaFlowSuite).toHaveBeenCalledTimes(
          route === "parallel scripts" ? 0 : 1 + expectedRetries,
        );
        expect(runQaTestFileScenarios).toHaveBeenCalledTimes(
          route === "parallel scripts" ? 2 + expectedRetries : 1,
        );
        expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(outputDir, "qa-suite-summary.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        for (const gate of gates) {
          gate.resolve();
        }
        await pending;
      }
    });
  });

  it.each(
    ["first", "nested"].flatMap((acquisition) =>
      [true, false].map((cleanupFailed) => ({ acquisition, cleanupFailed })),
    ),
  )(
    "preserves $acquisition credential failure policy after parity cleanup (cleanup failed: $cleanupFailed)",
    async ({ acquisition, cleanupFailed }) => {
      const repoRoot = await makeTempRepo("qa-suite-credential-cleanup-");
      const outputDir = path.join(repoRoot, "output");
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const poolError = Object.assign(new Error("no channel credential is available"), {
        code: "POOL_EXHAUSTED",
      });
      const cleanupError = new Error("owned Lab release failed");
      let registryError: unknown;
      const createTransport = qaTransportRegistry.createQaTransportAdapter;
      vi.spyOn(qaTransportRegistry, "createQaTransportAdapter").mockImplementation(
        async (...args) => {
          try {
            return await createTransport(...args);
          } catch (error) {
            registryError = error;
            throw error;
          }
        },
      );
      const stop = vi.fn(async () => {
        if (cleanupFailed) {
          throw cleanupError;
        }
      });
      const lab: QaLabServerHandle = {
        baseUrl: "http://127.0.0.1:43123",
        listenUrl: "http://127.0.0.1:43123",
        state: createQaBusState(),
        setControlUi: vi.fn(),
        setScenarioRun: vi.fn(),
        setLatestReport: vi.fn(),
        runSelfCheck: vi.fn(),
        stop,
      };
      const releaseParent = vi.fn(async () => {});
      let parentCreated = false;
      const create = vi.fn<QaTransportAdapterFactory["create"]>(async () => {
        if (acquisition === "first" || parentCreated) {
          expect(releaseParent).toHaveBeenCalledTimes(acquisition === "first" ? 0 : 1);
          throw poolError;
        }
        parentCreated = true;
        return {
          id: "whatsapp",
          label: "Leased test channel",
          accountId: "sut",
          requiredPluginIds: [],
          supportedActions: [],
          sendInbound: async (input) => lab.state.addInboundMessage(input),
          createGatewayConfig: () => ({}),
          async waitReady() {},
          buildAgentDelivery: ({ target }) => ({
            channel: "whatsapp",
            to: target,
            replyChannel: "whatsapp",
            replyTo: target,
          }),
          async handleAction() {},
          createReportNotes: () => [],
          cleanup: releaseParent,
        };
      });
      const factory: QaTransportAdapterFactory = {
        id: "whatsapp",
        matches: ({ channelId, driver }) => channelId === "whatsapp" && driver === "live",
        create,
      };
      let parityError: unknown;
      runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
        try {
          return await runQaRuntimeParitySuite({
            ...params,
            repoRoot,
            outputDir: params.outputDir!,
            startedAt: new Date("2026-08-04T00:00:00.000Z"),
            providerMode: "mock-openai",
            transportId: "qa-channel",
            primaryModel: "mock-openai/test-model",
            alternateModel: "mock-openai/test-model-alt",
            fastMode: true,
            concurrency: 1,
            selectedScenarios: scenarioCatalog
              .readQaBootstrapScenarioCatalog()
              .scenarios.filter((scenario) => params.scenarioIds?.includes(scenario.id)),
            startLab: async () => lab,
            progressEnabled: false,
            runtimePair: ["openclaw", "codex"],
            runQaFlowSuite: async (childParams) => {
              if (!childParams?.outputDir) {
                throw new Error("expected a parity child output directory");
              }
              // Fail at the real registry boundary before any Gateway can start.
              await createQaSuiteTransportAdapter({
                adapterFactories: childParams.adapterFactories,
                adapterOptions: childParams.adapterOptions,
                channelDriver: childParams.channelDriver,
                channelId: childParams.channelId,
                outputDir: childParams.outputDir,
                state: lab.state,
                transportId: "qa-channel",
              });
              throw new Error("child credential acquisition unexpectedly succeeded");
            },
          });
        } catch (error) {
          parityError = error;
          throw error;
        }
      });

      const pending = runQaSuite({
        repoRoot,
        outputDir,
        providerMode: "mock-openai",
        channelDriver: "live",
        adapterFactories: [factory],
        runtimePair: ["openclaw", "codex"],
        failFast: true,
        scenarioIds: ["whatsapp-status-command", "whatsapp-access-control-dm-open"],
      });
      if (cleanupFailed) {
        const failure: unknown = await pending.catch((error: unknown) => error);
        expect(failure).toBe(parityError);
        expect(failure).toBeInstanceOf(QaSuiteCleanupError);
        if (!(failure instanceof QaSuiteCleanupError)) {
          throw new Error("expected fatal parity cleanup failure");
        }
        expect(failure.cause).toBe(registryError);
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(registryError);
        expect(failure.errors[1]).toBe(cleanupError);
        await expect(
          fs.access(path.join(outputDir, "qa-suite-summary.json")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        const result = await pending;
        expect(parityError).toBe(registryError);
        expect(result.executionKind).toBe("suite");
        expect(result.result.scenarios).toMatchObject([
          { status: "fail", details: expect.stringContaining("channel credential unavailable") },
        ]);
        expect(result.result.scenarios).toHaveLength(1);
        const evidence = validateQaEvidenceSummaryJson(
          JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")),
        );
        expect(projectQaEvidenceScenarioOutcomes(evidence).map((entry) => entry.status)).toEqual([
          "blocked",
          null,
        ]);
      }
      expect(registryError).toBeInstanceOf(Error);
      if (!(registryError instanceof Error)) {
        throw new Error("expected the registry's credential failure");
      }
      expect(registryError.message).toContain("failed to create QA transport live:whatsapp:");
      expect(registryError.cause).toBe(poolError);
      expect(create).toHaveBeenCalledTimes(acquisition === "first" ? 1 : 2);
      expect(releaseParent).toHaveBeenCalledTimes(acquisition === "first" ? 0 : 1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
      expect(runQaTestFileScenarios).not.toHaveBeenCalled();
      expect(
        stderrWrite.mock.calls.filter(([line]) => String(line).includes("infra retry")),
      ).toEqual([]);
    },
  );
});
