import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import {
  gatewayEnv,
  IOS_RELEASE_TESTS,
  MODEL_REF,
  OperationError,
  operationError,
  testRunnerEnv,
  type Mode,
  type Operation,
  type TrialDependencies,
} from "../ios-release-e2e.js";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mjs";

const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export async function createNativeDependencies(options: {
  mode: Mode;
  targetSha: string;
  signal: AbortSignal;
  proof: Record<string, unknown>;
}): Promise<{ dependencies: TrialDependencies; cleanup: () => Promise<void> }> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macos-arm64-required");
  }
  const cwd = process.cwd();
  let retainRoot = false;
  const preserveResources = () => {
    if (!retainRoot) {
      console.error("iOS E2E resources retained: owned cleanup could not be confirmed.");
    }
    retainRoot = true;
    options.proof.resourcesPreserved = true;
  };
  const command = async (
    operation: Operation,
    bin: string,
    args: string[],
    config: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cleanup?: boolean } = {},
  ) => {
    let stdout = "";
    let stderr = "";
    let code: number;
    try {
      code = await runManagedCommand({
        bin,
        args,
        cwd,
        env: { ...process.env, ...config.env },
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: config.timeoutMs ?? 120_000,
        requireProcessTreeExit: true,
        signal: config.cleanup ? undefined : options.signal,
        onReady(child) {
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout = (stdout + chunk.toString()).slice(-16 * 1024 * 1024);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4096);
          });
        },
      });
    } catch (error) {
      if (hasUnjoinedWork(error)) {
        preserveResources();
      }
      throw operationError(operation, error);
    }
    if (code !== 0) {
      throw new OperationError(operation, "exit", code, `${stderr}\n${stdout.slice(-4096)}`);
    }
    return stdout.trim();
  };
  const head = await command("source-head", "git", ["rev-parse", "HEAD"]);
  if (head !== options.targetSha) {
    throw new OperationError("source-head", "identity-mismatch");
  }
  if (
    await command("source-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"])
  ) {
    throw new OperationError("source-status", "dirty-source");
  }
  options.proof.harnessSha = head;
  const xcodeVersion = await command("xcode-version", "xcodebuild", ["-version"]);
  const xcode = /^Xcode ([0-9.]+)\r?\nBuild version ([A-Za-z0-9]+)$/u.exec(xcodeVersion);
  if (!xcode) {
    throw new OperationError("xcode-version", "failed");
  }
  const binary = process.env.OPENCLAW_CI_SIMSLIM_BINARY;
  if (options.mode === "compare" && (!binary || !path.isAbsolute(binary))) {
    throw new OperationError("simslim-version", "not-found");
  }
  if (binary && (await command("simslim-version", binary, ["--version"])) !== "simslim 0.8.0") {
    throw new OperationError("simslim-version", "identity-mismatch");
  }
  const runtimes: {
    runtimes: {
      isAvailable: boolean;
      version: string;
      identifier: string;
      supportedArchitectures: string[];
      supportedDeviceTypes: { identifier: string }[];
    }[];
  } = JSON.parse(
    await command("simulator-runtime", "xcrun", ["simctl", "list", "runtimes", "--json"]),
  );
  const runtime = runtimes.runtimes
    .filter(
      (item) =>
        item.isAvailable &&
        item.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        item.supportedArchitectures.includes(process.arch) &&
        item.supportedDeviceTypes.some((device) => device.identifier === DEVICE_TYPE),
    )
    .toSorted(
      (left, right) =>
        right.version.localeCompare(left.version, "en", { numeric: true }) ||
        left.identifier.localeCompare(right.identifier),
    )[0];
  if (!runtime) {
    throw new OperationError("simulator-runtime", "not-found");
  }
  Object.assign(options.proof, {
    xcode: xcode[1],
    xcodeBuild: xcode[2],
    runtime: runtime.version,
    runtimeIdentifier: runtime.identifier,
    deviceType: DEVICE_TYPE,
    simslim: binary ? "0.8.0" : null,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-ios-release-e2e-"));
  // Never export raw xcresults or fixture logs: they can contain pairing credentials.
  const cleanup = async () => {
    if (retainRoot) {
      throw new OperationError("cleanup", "cleanup-unconfirmed");
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    const buildStarted = performance.now();
    await command(
      "gateway-build",
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/build-all.mts", "qaRuntime"],
      { timeoutMs: 1_200_000 },
    );
    options.proof.gatewayBuildMs = performance.now() - buildStarted;
    const nativeStarted = performance.now();
    await command("native-generate", "pnpm", ["ios:gen"]);
    const buildArgs = [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClawUITests",
      "-configuration",
      "Debug",
      "-derivedDataPath",
      path.join(root, "DerivedData"),
      // Simulator Keychain access needs entitlements, but no signing certificate.
      "CODE_SIGNING_ALLOWED=YES",
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGN_STYLE=Manual",
      "PROVISIONING_PROFILE=",
      "PROVISIONING_PROFILE_SPECIFIER=",
      "-parallel-testing-enabled",
      "NO",
    ];
    await command(
      "native-build",
      "xcodebuild",
      [
        ...buildArgs,
        "-destination",
        "generic/platform=iOS Simulator",
        ...IOS_RELEASE_TESTS.map((test) => `-only-testing:${test}`),
        "build-for-testing",
      ],
      { timeoutMs: 1_800_000 },
    );
    options.proof.nativeBuildMs = performance.now() - nativeStarted;
    const { createOpenClawTestInstance } =
      await import("../../test/helpers/openclaw-test-instance.js");
    return {
      cleanup,
      dependencies: {
        signal: options.signal,
        now: () => performance.now(),
        wait: async (ms, signal) => {
          await sleep(ms, undefined, { signal });
        },
        measure: Boolean(binary),
        async create(test, arm, index) {
          let udid: string | undefined;
          let instance: OpenClawTestInstance | undefined;
          const mockAbort = new AbortController();
          let mockDone: Promise<void> | undefined;
          let mockFailed = false;
          const requestLog = path.join(root, `requests-${index}.jsonl`);
          const release = async () => {
            const results = await Promise.allSettled([
              instance?.cleanup(),
              (async () => {
                mockAbort.abort();
                await mockDone;
              })(),
              udid
                ? command("simulator-delete", "xcrun", ["simctl", "delete", udid], {
                    cleanup: true,
                  })
                : Promise.resolve(),
            ]);
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") {
              preserveResources();
              throw failure.reason instanceof OperationError
                ? failure.reason
                : new OperationError("cleanup", "cleanup-unconfirmed");
            }
            if (retainRoot) {
              throw new OperationError("cleanup", "cleanup-unconfirmed");
            }
          };
          return {
            async prepare() {
              udid = await command("simulator-create", "xcrun", [
                "simctl",
                "create",
                `openclaw-ios-e2e-${index}`,
                DEVICE_TYPE,
                runtime.identifier,
              ]);
              if (!UUID.test(udid)) {
                udid = undefined;
                preserveResources();
                throw new OperationError("simulator-create", "failed");
              }
              let resolvePort!: (port: number) => void;
              let rejectPort!: (error: Error) => void;
              const portReady = new Promise<number>((resolve, reject) => {
                resolvePort = resolve;
                rejectPort = reject;
              });
              let output = "";
              mockDone = runManagedCommand({
                bin: process.execPath,
                args: ["scripts/e2e/mock-openai-server.mjs"],
                cwd,
                env: {
                  ...process.env,
                  MOCK_PORT: "0",
                  MOCK_BIND_HOST: "127.0.0.1",
                  MOCK_REQUEST_LOG: requestLog,
                },
                stdio: ["ignore", "pipe", "pipe"],
                requireProcessTreeExit: true,
                signal: AbortSignal.any([options.signal, mockAbort.signal]),
                onReady(child) {
                  child.stdout?.on("data", (chunk: Buffer) => {
                    output = (output + chunk.toString()).slice(-4096);
                    const match = /mock-openai listening on (\d+)/u.exec(output);
                    if (match) {
                      resolvePort(Number(match[1]));
                    }
                  });
                  child.stderr?.resume();
                },
              }).then(
                () => {
                  mockFailed = true;
                  rejectPort(new Error("mock-exited"));
                },
                (error: unknown) => {
                  mockFailed = true;
                  rejectPort(operationError("fixture-server", error));
                  if (hasUnjoinedWork(error)) {
                    preserveResources();
                    throw operationError("fixture-server", error);
                  }
                  if (
                    !(mockAbort.signal.aborted || options.signal.aborted) ||
                    (error as { code?: string }).code !== "ABORT_ERR"
                  ) {
                    throw operationError("fixture-server", error);
                  }
                },
              );
              // Observe eager failures, then join this same owner during cleanup.
              void mockDone.catch(() => {});
              const readinessAbort = new AbortController();
              let port: number;
              try {
                port = await Promise.race([
                  portReady,
                  sleep(30_000, undefined, { signal: readinessAbort.signal }).then(() => {
                    throw new OperationError("fixture-server", "timeout");
                  }),
                ]);
              } finally {
                readinessAbort.abort();
              }
              const config = { gateway: { controlUi: { enabled: false } } };
              applyMockOpenAiModelConfig(config, { mockPort: port, modelRef: MODEL_REF });
              try {
                instance = await createOpenClawTestInstance({
                  name: `ios-release-e2e-${index}`,
                  cwd,
                  config,
                  env: gatewayEnv,
                });
                await instance.startGateway();
              } catch (error) {
                if (hasUnjoinedWork(error)) {
                  preserveResources();
                }
                throw operationError("gateway-start", error);
              }
              if (arm === "simslim") {
                await command(
                  "simulator-slim",
                  "/bin/bash",
                  ["scripts/ios-simulator-prepare.sh", udid],
                  {
                    env: { CI: "true", OPENCLAW_CI_SIMSLIM_BINARY: binary },
                    timeoutMs: 900_000,
                  },
                );
              } else {
                await command("simulator-boot", "xcrun", ["simctl", "boot", udid]);
                await command("simulator-ready", "xcrun", ["simctl", "bootstatus", udid, "-b"], {
                  timeoutMs: 600_000,
                });
              }
            },
            async test() {
              if (!instance || !udid) {
                throw new Error("trial-not-prepared");
              }
              let qr: Awaited<ReturnType<OpenClawTestInstance["cli"]>>;
              try {
                qr = await instance.cli(["qr", "--url", instance.url, "--setup-code-only"]);
              } catch (error) {
                if (hasUnjoinedWork(error)) {
                  preserveResources();
                }
                throw operationError("setup-code", error);
              }
              if (qr.code !== 0 || qr.signal || !qr.stdout.trim()) {
                throw new OperationError("setup-code", "failed", qr.code ?? undefined);
              }
              const resultBundle = path.join(root, `trial-${index}.xcresult`);
              await command(
                "native-test",
                "xcodebuild",
                [
                  ...buildArgs,
                  "-destination",
                  `platform=iOS Simulator,id=${udid}`,
                  "-resultBundlePath",
                  resultBundle,
                  `-only-testing:${test}`,
                  "test-without-building",
                ],
                { env: testRunnerEnv(qr.stdout.trim()), timeoutMs: 600_000 },
              );
              if (mockFailed) {
                throw new OperationError("fixture-server", "failed");
              }
              if (test === IOS_RELEASE_TESTS[1]) {
                const requests = (await readFile(requestLog, "utf8"))
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line));
                if (
                  !requests.some(
                    (request) =>
                      request.path === "/v1/responses" &&
                      JSON.parse(request.body).model === "ios-e2e",
                  )
                ) {
                  throw new OperationError("provider-rpc", "failed");
                }
              }
              return JSON.parse(
                await command("test-results", "xcrun", [
                  "xcresulttool",
                  "get",
                  "test-results",
                  "tests",
                  "--path",
                  resultBundle,
                ]),
              );
            },
            measure: () =>
              command("simulator-measure", binary!, ["measure", udid!, "--json"], {
                timeoutMs: 5_000,
              }).then((text) => JSON.parse(text)),
            cleanup: release,
          };
        },
      },
    };
  } catch (error) {
    if (!retainRoot) {
      await cleanup();
    }
    throw error;
  }
}
