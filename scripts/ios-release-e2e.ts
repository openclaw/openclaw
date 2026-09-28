import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  collectNestedErrorCandidates,
  extractErrorCodeOrErrno,
} from "@openclaw/normalization-core/error-coercion";

export const IOS_RELEASE_TESTS = [
  "OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayFreshInstallSetupAndRelaunch",
  "OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayChatRoundTripAndControlOverview",
] as const;
export const MODEL_REF = "openai/ios-e2e";
export const IOS_RELEASE_CHAT_FAILURE =
  /IOS_RELEASE_CHAT_FAILURE (seed-[0-2]|final) (submission|reply) draft=(true|false) keyboard=(true|false) reply=(true|false) writing=(true|false) jump=(true|false) foreground=(true|false) input=(true|false) transcript=(true|false) send=(true|false)/u;
export const IOS_RELEASE_TEST_FAILURE_LOCATION =
  /(?:^|\/)OpenClawSnapshotUITests\.swift:([1-9][0-9]{0,4})(?::[0-9]+)?: error:/gmu;
export const SAMPLE_INTERVAL_MS = 1_000;
export const MAX_SAMPLE_GAP_MS = 3_000;
export type Mode = "stock" | "compare";
export type Arm = "stock" | "simslim";
type TestIdentity = (typeof IOS_RELEASE_TESTS)[number];
type JsonObject = Record<string, unknown>;

export type Operation =
  | "source-head"
  | "source-status"
  | "xcode-version"
  | "simslim-version"
  | "simulator-runtime"
  | "gateway-build"
  | "native-generate"
  | "native-build"
  | "simulator-create"
  | "simulator-boot"
  | "simulator-ready"
  | "simulator-slim"
  | "simulator-delete"
  | "fixture-server"
  | "gateway-start"
  | "setup-code"
  | "native-test"
  | "app-diagnostics"
  | "provider-rpc"
  | "test-results"
  | "simulator-measure"
  | "cleanup";
type OperationCode =
  | "failed"
  | "exit"
  | "timeout"
  | "cancelled"
  | "not-found"
  | "permission-denied"
  | "dirty-source"
  | "identity-mismatch"
  | "unsupported"
  | "cleanup-unconfirmed";
type Diagnostic = {
  operation: Operation;
  code: OperationCode;
  exitCode?: number;
  errorCode?: string;
  context: string[];
};

export class OperationError extends Error {
  diagnostic: Diagnostic;
  constructor(operation: Operation, code: OperationCode, exitCode?: number, output = "") {
    super(`${operation}:${code}`);
    // Export recognized categories, never arbitrary tool output or process arguments.
    const markers: [string, string][] = [
      ["unable to find a destination", "destination-unavailable"],
      ["could not resolve package dependencies", "package-resolution-failed"],
      ["build failed", "build-failed"],
      ["test failed", "test-failed"],
      ["permission denied", "permission-denied"],
      ["no space left", "disk-full"],
      ["connection refused", "connection-refused"],
    ];
    this.diagnostic = {
      operation,
      code,
      ...(Number.isInteger(exitCode) && exitCode! >= 0 && exitCode! <= 255 ? { exitCode } : {}),
      context: markers
        .filter(([match]) => output.toLowerCase().includes(match))
        .map(([, tag]) => tag),
    };
    if (operation === "native-test") {
      const chatFailure = output.match(IOS_RELEASE_CHAT_FAILURE);
      if (chatFailure) {
        this.diagnostic.context.push(
          `chat-stage:${chatFailure[1]}`,
          `chat-checkpoint:${chatFailure[2]}`,
          `chat-draft-retained:${chatFailure[3]}`,
          `chat-keyboard:${chatFailure[4]}`,
          `chat-reply-present:${chatFailure[5]}`,
          `chat-writing:${chatFailure[6]}`,
          `chat-jump:${chatFailure[7]}`,
          `chat-app-foreground:${chatFailure[8]}`,
          `chat-input-present:${chatFailure[9]}`,
          `chat-transcript-present:${chatFailure[10]}`,
          `chat-send-present:${chatFailure[11]}`,
        );
      }
      for (const status of ["started", "passed", "failed"] as const) {
        if (
          IOS_RELEASE_TESTS.some((test) => {
            const [bundle, suite, name] = test.split("/");
            return output.includes(`Test Case '-[${bundle}.${suite} ${name}]' ${status}`);
          })
        ) {
          this.diagnostic.context.push(`xctest-${status}`);
        }
      }
      // Keep failure locations actionable without exporting assertion text, paths, or credentials.
      const lines = [...output.matchAll(IOS_RELEASE_TEST_FAILURE_LOCATION)].map(
        (match) => match[1],
      );
      this.diagnostic.context.push(
        ...[...new Set(lines)].slice(0, 8).map((line) => `xctest-line:${line}`),
      );
    }
  }
}

export function operationError(operation: Operation, error: unknown, output = ""): OperationError {
  const code = collectNestedErrorCandidates(error)
    .map(extractErrorCodeOrErrno)
    .find(
      (candidate) =>
        candidate &&
        ["ETIMEDOUT", "ABORT_ERR", "ENOENT", "EACCES", "EPERM", "ENOSPC"].includes(candidate),
    );
  const failure = new OperationError(
    operation,
    code === "ETIMEDOUT"
      ? "timeout"
      : code === "ABORT_ERR"
        ? "cancelled"
        : code === "ENOENT"
          ? "not-found"
          : code === "EACCES"
            ? "permission-denied"
            : "failed",
    undefined,
    output,
  );
  if (code) {
    failure.diagnostic.errorCode = code;
  }
  return failure;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-json-object");
  }
  return value as JsonObject;
}

// XCTest identifies class/test(); the UI bundle ancestry supplies the target.
export function requireExactTestResult(value: unknown, expected: TestIdentity): void {
  const cases: { node: JsonObject; bundle?: string }[] = [];
  const visit = (entry: unknown, bundle?: string) => {
    const node = object(entry);
    const owner =
      node.nodeType === "UI test bundle"
        ? typeof node.name === "string"
          ? node.name
          : undefined
        : node.nodeType === "Unit test bundle"
          ? undefined
          : bundle;
    if (node.nodeType === "Test Case") {
      cases.push({ node, bundle: owner });
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        throw new Error("invalid-test-children");
      }
      node.children.forEach((child) => visit(child, owner));
    }
  };
  const roots = object(value).testNodes;
  if (!Array.isArray(roots)) {
    throw new Error("missing-test-nodes");
  }
  roots.forEach((node) => visit(node));
  if (cases.some(({ node }) => node.result === "Skipped")) {
    throw new Error("test-skipped");
  }
  const [testCase] = cases;
  if (
    cases.length !== 1 ||
    !testCase ||
    testCase.bundle !== expected.split("/")[0] ||
    testCase.node.nodeIdentifier !== `${expected.split("/").slice(1).join("/")}()` ||
    testCase.node.result !== "Passed"
  ) {
    throw new Error("test-identity-or-result");
  }
  let repetitions = 0;
  let runs = 0;
  const checkRuns = (entry: unknown) => {
    const node = object(entry);
    if (node.nodeType === "Repetition") {
      repetitions++;
    }
    if (node.nodeType === "Test Case Run") {
      runs++;
    }
    if (node.result !== undefined && node.result !== "Passed") {
      throw new Error("failed-test-child");
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(checkRuns);
    }
  };
  checkRuns(testCase.node);
  if (repetitions > 1 || runs > 1) {
    throw new Error("repeated-test");
  }
}

export type Measurement = { processes: number; bytes: number; cpu: number };
export function parseMeasurement(value: unknown): Measurement {
  const row = object(value);
  if (
    !Number.isSafeInteger(row.processes) ||
    (row.processes as number) <= 0 ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) <= 0 ||
    typeof row.cpu !== "number" ||
    !Number.isFinite(row.cpu) ||
    row.cpu < 0
  ) {
    throw new Error("invalid-measurement");
  }
  return { processes: row.processes as number, bytes: row.bytes as number, cpu: row.cpu };
}

export type Sample = Measurement & { atMs: number };
export function summarizeMeasurements(samples: Sample[], errors: number, durationMs: number) {
  let previous = 0;
  const gaps = [...samples.map((sample) => sample.atMs), durationMs].map((at) => {
    const gap = at - previous;
    previous = at;
    return gap;
  });
  const gapCount = gaps.filter((gap) => gap < 0 || gap > MAX_SAMPLE_GAP_MS).length;
  return {
    window: "boot-complete-test" as const,
    metric: "simulator-tree-phys-footprint" as const,
    intervalMs: SAMPLE_INTERVAL_MS,
    samples,
    errors,
    gapCount,
    maxGapMs: Math.max(0, ...gaps),
    peakBytes: Math.max(0, ...samples.map((sample) => sample.bytes)),
    complete: samples.length >= 2 && errors === 0 && gapCount === 0,
  };
}

export function armPlan(mode: Mode): { pair: number; arm: Arm }[] {
  if (mode === "stock") {
    return [{ pair: 1, arm: "stock" }];
  }
  return [
    ["stock", "simslim"],
    ["simslim", "stock"],
    ["stock", "simslim"],
    ["simslim", "stock"],
  ].flatMap((arms, index) => arms.map((arm) => ({ pair: index + 1, arm: arm as Arm })));
}

export const gatewayEnv = {
  OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
  OPENCLAW_SKIP_CHANNELS: "0",
  OPENCLAW_SKIP_PROVIDERS: "0",
  OPENAI_API_KEY: "ios-e2e-synthetic-key",
  OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
};

export function testRunnerEnv(setupCode: string): NodeJS.ProcessEnv {
  return {
    TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY: "1",
    TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE: setupCode,
  };
}

export type TrialResources = {
  prepare: () => Promise<void>;
  test: () => Promise<unknown>;
  measure: () => Promise<unknown>;
  cleanup: () => Promise<void>;
};
export type Trial = {
  pair: number;
  arm: Arm;
  test: TestIdentity;
  status: "failed" | "passed";
  errors: string[];
  diagnostics: Diagnostic[];
  preparationMs: number;
  testMs: number;
  totalMs: number;
  measurement?: ReturnType<typeof summarizeMeasurements>;
};
export type TrialDependencies = {
  create: (test: TestIdentity, arm: Arm, index: number) => Promise<TrialResources>;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  measure: boolean;
};

export async function runTrials(mode: Mode, deps: TrialDependencies) {
  if (mode === "compare" && !deps.measure) {
    throw new Error("comparison-meter-required");
  }
  const trials: Trial[] = [];
  const arms: { pair: number; arm: Arm; totalMs: number }[] = [];
  for (const planned of armPlan(mode)) {
    const armStarted = deps.now();
    for (const test of IOS_RELEASE_TESTS) {
      if (deps.signal.aborted) {
        return { trials, arms, complete: false };
      }
      const started = deps.now();
      const trial: Trial = {
        ...planned,
        test,
        status: "failed",
        errors: [],
        diagnostics: [],
        preparationMs: 0,
        testMs: 0,
        totalMs: 0,
      };
      trials.push(trial);
      let resources: TrialResources | undefined;
      let testStarted: number | undefined;
      let collector: Promise<void> | undefined;
      const stopCollection = new AbortController();
      const samples: Sample[] = [];
      let measurementErrors = 0;
      let cleanupFailed = false;
      let stage = "preparation";
      try {
        resources = await deps.create(test, planned.arm, trials.length);
        await resources.prepare();
        trial.preparationMs = deps.now() - started;
        deps.signal.throwIfAborted();
        stage = "test";
        testStarted = deps.now();
        if (deps.measure) {
          const measure = async () => {
            try {
              const measurement = parseMeasurement(await resources!.measure());
              samples.push({ ...measurement, atMs: deps.now() - testStarted! });
            } catch (error) {
              measurementErrors++;
              if (error instanceof OperationError && trial.diagnostics.length < 8) {
                trial.diagnostics.push(error.diagnostic);
              }
            }
          };
          // Sample serially, only after preparation has completed.
          await measure();
          collector = (async () => {
            let next = testStarted! + SAMPLE_INTERVAL_MS;
            while (!stopCollection.signal.aborted && !deps.signal.aborted) {
              try {
                await deps.wait(Math.max(0, next - deps.now()), stopCollection.signal);
              } catch {
                if (!stopCollection.signal.aborted && !deps.signal.aborted) {
                  measurementErrors++;
                }
                break;
              }
              if (stopCollection.signal.aborted || deps.signal.aborted) {
                break;
              }
              await measure();
              next += SAMPLE_INTERVAL_MS;
            }
          })();
        }
        requireExactTestResult(await resources.test(), test);
      } catch (error) {
        if (error instanceof OperationError) {
          trial.diagnostics.push(error.diagnostic);
        }
        const resultErrors = [
          "test-skipped",
          "test-identity-or-result",
          "failed-test-child",
          "repeated-test",
        ];
        trial.errors.push(
          deps.signal.aborted
            ? "cancelled"
            : (error as { code?: string })?.code === "ETIMEDOUT" ||
                (error instanceof OperationError && error.diagnostic.code === "timeout")
              ? `${stage}-timeout`
              : error instanceof Error && resultErrors.includes(error.message)
                ? error.message
                : `${stage}-failed`,
        );
      } finally {
        stopCollection.abort();
        await collector;
        if (testStarted !== undefined) {
          trial.testMs = deps.now() - testStarted;
          if (deps.measure) {
            trial.measurement = summarizeMeasurements(samples, measurementErrors, trial.testMs);
            if (!trial.measurement.complete) {
              trial.errors.push("incomplete-measurement");
            }
          }
        } else {
          trial.preparationMs = deps.now() - started;
        }
        try {
          await resources?.cleanup();
        } catch (error) {
          if (error instanceof OperationError) {
            trial.diagnostics.push(error.diagnostic);
          }
          trial.errors.push("cleanup-failed");
          cleanupFailed = true;
        }
        trial.totalMs = deps.now() - started;
        if (deps.signal.aborted && !trial.errors.includes("cancelled")) {
          trial.errors.push("cancelled");
        }
        trial.status = trial.errors.length === 0 ? "passed" : "failed";
      }
      // Unconfirmed cleanup cannot safely share a host with another trial.
      if (cleanupFailed) {
        return { trials, arms, complete: false };
      }
    }
    arms.push({ ...planned, totalMs: deps.now() - armStarted });
  }
  return { trials, arms, complete: !deps.signal.aborted };
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "stock" },
      "target-sha": { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    (values.mode !== "stock" && values.mode !== "compare") ||
    !/^[a-f0-9]{40}$/u.test(values["target-sha"] ?? "") ||
    !values.output
  ) {
    throw new Error("usage: --mode stock|compare --target-sha <full-sha> --output <proof.json>");
  }
  const started = performance.now();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const proof: Record<string, unknown> = {
    schema: 1,
    targetSha: values["target-sha"],
    harnessSha: null,
    mode: values.mode,
    model: MODEL_REF,
    status: "failed",
    trials: [],
    errors: [],
    diagnostics: [],
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const { createNativeDependencies } = await import("./lib/ios-release-e2e-native.js");
    const native = await createNativeDependencies({
      mode: values.mode,
      targetSha: values["target-sha"]!,
      signal: abort.signal,
      proof,
    });
    cleanup = native.cleanup;
    const result = await runTrials(values.mode, native.dependencies);
    Object.assign(proof, result);
    proof.status =
      result.complete && result.trials.every((trial) => trial.status === "passed")
        ? "passed"
        : "failed";
  } catch (error) {
    if (error instanceof OperationError) {
      (proof.diagnostics as Diagnostic[]).push(error.diagnostic);
    }
    (proof.errors as string[]).push(abort.signal.aborted ? "cancelled" : "gate-setup-failed");
  } finally {
    try {
      await cleanup?.();
    } catch (error) {
      if (error instanceof OperationError) {
        (proof.diagnostics as Diagnostic[]).push(error.diagnostic);
      }
      proof.status = "failed";
      (proof.errors as string[]).push("gate-cleanup-failed");
    }
    proof.harnessMs = performance.now() - started;
    proof.overallMs = proof.harnessMs;
    await mkdir(path.dirname(values.output), { recursive: true });
    await writeFile(values.output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  process.exitCode = proof.status === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // The native adapter imports this module, so finish module evaluation before loading it.
  void main().catch(() => {
    console.error("iOS E2E failed before proof could be written.");
    process.exitCode = 1;
  });
}
