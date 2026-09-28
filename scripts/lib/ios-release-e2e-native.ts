import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DevicePairSetupCodeResult } from "../../packages/gateway-protocol/src/schema/devices.js";
import { isGatewayTransportError } from "../../src/gateway/transport-error.js";
import { stripEnvelope } from "../../src/shared/chat-envelope.js";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readMockUserText } from "../e2e/lib/mock-inference-facts.js";
import {
  gatewayEnv,
  IOS_RELEASE_TEST_FAILURE_LOCATION,
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
const CHAT_MARKERS = [
  ["first", "OPENCLAW_E2E_FIRST"],
  ["second", "OPENCLAW_E2E_SECOND"],
  ["relaunch", "OPENCLAW_E2E_RELAUNCH"],
] as const;

export async function createNativeDependencies(options: {
  mode: Mode;
  targetSha: string;
  signal: AbortSignal;
  proof: Record<string, unknown>;
  buildDir?: string;
  gatewayOnly?: boolean;
  onProgress?: () => Promise<void>;
}): Promise<{
  dependencies: TrialDependencies;
  assertCurrentSource: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
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
  const phases: {
    operation: Operation;
    trial?: number;
    status: "running" | "passed" | "failed";
    ms: number;
    checkpoint?: string;
  }[] = [];
  options.proof.phases = phases;
  let currentTrial: number | undefined;
  const phase = async <T>(operation: Operation, action: () => Promise<T>): Promise<T> => {
    const entry: (typeof phases)[number] = {
      operation,
      ...(currentTrial ? { trial: currentTrial } : {}),
      status: "running",
      ms: 0,
    };
    if (operation === "simulator-measure") {
      return action();
    }
    phases.push(entry);
    await options.onProgress?.();
    const started = performance.now();
    console.error(`iOS qualification: ${operation} started`);
    try {
      const value = await action();
      entry.status = "passed";
      return value;
    } catch (error) {
      entry.status = "failed";
      throw error;
    } finally {
      entry.ms = Math.round(performance.now() - started);
      console.error(`iOS qualification: ${operation} ${entry.status} (${entry.ms} ms)`);
      await options.onProgress?.();
    }
  };
  const command = async (
    operation: Operation,
    bin: string,
    args: string[],
    config: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      cleanup?: boolean;
      captureChatFailure?: () => Promise<string[]>;
      signal?: AbortSignal;
    } = {},
  ) =>
    phase(operation, async () => {
      let stdout = "";
      let stderr = "";
      const started = performance.now();
      let failureContext: Promise<string[]> | undefined;
      const observeChatFailure = () => {
        const capture = config.captureChatFailure;
        if (
          !failureContext &&
          capture &&
          !`${stdout}\n${stderr}`.matchAll(IOS_RELEASE_TEST_FAILURE_LOCATION).next().done
        ) {
          const timing = `failure-evidence-at-ms:${Math.round(performance.now() - started)}`;
          // Snapshot at the assertion, before XCTest's potentially lengthy teardown; always join below.
          failureContext = Promise.resolve()
            .then(capture)
            .then(
              (context) => [timing, ...context],
              () => [timing, "chat-evidence-unavailable"],
            );
        }
      };
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
          signal: config.cleanup ? undefined : (config.signal ?? options.signal),
          onReady(child) {
            child.stdout?.on("data", (chunk: Buffer) => {
              stdout = (stdout + chunk.toString()).slice(-16 * 1024 * 1024);
              observeChatFailure();
              if (operation === "native-test") {
                const checkpoint = [
                  ...stdout.matchAll(
                    /IOS_RELEASE_CHECKPOINT (paired|first|second|relaunched|relaunch|overview)\b/gu,
                  ),
                ].at(-1)?.[1];
                const activePhase = phases.findLast((entry) => entry.operation === "native-test");
                if (checkpoint && activePhase && activePhase.checkpoint !== checkpoint) {
                  activePhase.checkpoint = checkpoint;
                  void options.onProgress?.().catch(() => {});
                }
              }
            });
            child.stderr?.on("data", (chunk: Buffer) => {
              stderr = (stderr + chunk.toString()).slice(-4096);
              observeChatFailure();
            });
          },
        });
      } catch (error) {
        if (hasUnjoinedWork(error)) {
          preserveResources();
        }
        const failure = operationError(operation, error, `${stderr}\n${stdout}`);
        failure.diagnostic.context.push(...((await failureContext) ?? []));
        throw failure;
      }
      const context = (await failureContext) ?? [];
      if (code !== 0) {
        const failure = new OperationError(operation, "exit", code, `${stderr}\n${stdout}`);
        failure.diagnostic.context.push(...context);
        throw failure;
      }
      return stdout.trim();
    });
  const assertCurrentSource = async () => {
    const head = await command("source-head", "git", ["rev-parse", "HEAD"]);
    if (head !== options.targetSha) {
      throw new OperationError("source-head", "identity-mismatch");
    }
    if (
      await command("source-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"])
    ) {
      throw new OperationError("source-status", "dirty-source");
    }
  };
  await assertCurrentSource();
  options.proof.harnessSha = options.targetSha;
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
    const buildArgs = [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClawUITests",
      "-configuration",
      "Debug",
      // Simulator Keychain access needs entitlements, but no signing certificate.
      "CODE_SIGNING_ALLOWED=YES",
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGN_STYLE=Manual",
      "PROVISIONING_PROFILE=",
      "PROVISIONING_PROFILE_SPECIFIER=",
      "-parallel-testing-enabled",
      "NO",
    ];
    let derivedDataPath = "";
    let xctestrunPath = "";
    if (!options.gatewayOnly) {
      const { prepareIOSReleaseNativeBuild } = await import("./ios-release-e2e-build.js");
      const sdkVersion = await command("xcode-version", "xcrun", [
        "--sdk",
        "iphonesimulator",
        "--show-sdk-build-version",
      ]);
      const developerDir = await realpath(
        await command("xcode-version", "xcode-select", ["--print-path"]),
      );
      const build = await phase("native-build-reuse", () =>
        prepareIOSReleaseNativeBuild({
          buildDir: options.buildDir ?? path.join(root, "native-build"),
          identity: {
            sourceSha: options.targetSha,
            checkoutPath: cwd,
            xcodeVersion,
            sdkVersion,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            developerDir,
            buildArgs,
            generatorArgs: ["ios:gen"],
          },
          assertCurrentSource,
          build: async (destination) => {
            await command("native-generate", "pnpm", ["ios:gen"]);
            await command(
              "native-build",
              "xcodebuild",
              [
                ...buildArgs,
                "-derivedDataPath",
                destination,
                "-destination",
                "generic/platform=iOS Simulator",
                ...IOS_RELEASE_TESTS.map((test) => `-only-testing:${test}`),
                "build-for-testing",
              ],
              { timeoutMs: 1_800_000 },
            );
          },
        }),
      );
      derivedDataPath = build.derivedDataPath;
      xctestrunPath = build.xctestrunPath;
      options.proof.nativeBuildReused = build.reused;
      options.proof.nativeBuildMs = performance.now() - nativeStarted;
    }
    const { createOpenClawTestInstance } =
      await import("../../test/helpers/openclaw-test-instance.js");
    const { callGateway } = await import("../../src/gateway/call.js");
    return {
      assertCurrentSource,
      cleanup,
      dependencies: {
        signal: options.signal,
        now: () => performance.now(),
        wait: async (ms, signal) => {
          await sleep(ms, undefined, { signal });
        },
        measure: Boolean(binary),
        async create(arm, index) {
          currentTrial = index;
          const fixtureEvidence: Record<string, unknown> = { trial: index };
          const fixtures = (options.proof.fixtures ??= []) as Record<string, unknown>[];
          fixtures.push(fixtureEvidence);
          let udid: string | undefined;
          let instance: OpenClawTestInstance | undefined;
          let setupCode = "";
          const mockAbort = new AbortController();
          let mockDone: Promise<void> | undefined;
          let mockFailed = false;
          let closingFixture = false;
          let gatewayExited = false;
          const fixtureAbort = new AbortController();
          const fixtureSignal = AbortSignal.any([options.signal, fixtureAbort.signal]);
          const gatewayExit = () => {
            if (!closingFixture) {
              gatewayExited = true;
              fixtureEvidence.gatewayExited = true;
              fixtureAbort.abort();
            }
          };
          const requireLiveFixture = () => {
            if (
              gatewayExited ||
              (instance?.child &&
                (instance.child.exitCode !== null || instance.child.signalCode !== null))
            ) {
              throw new OperationError(
                "gateway-start",
                "exit",
                instance?.child?.exitCode ?? undefined,
              );
            }
            if (mockFailed) {
              throw new OperationError("fixture-server", "failed");
            }
          };
          const requestLog = path.join(root, `requests-${index}.jsonl`);
          let fixtureCleanup: Promise<void> | undefined;
          const releaseFixture = () =>
            (fixtureCleanup ??= (async () => {
              closingFixture = true;
              instance?.child?.off("exit", gatewayExit);
              const results = await Promise.allSettled([
                instance?.cleanup(),
                (async () => {
                  mockAbort.abort();
                  await mockDone;
                })(),
              ]);
              const failure = results.find((entry) => entry.status === "rejected");
              if (failure?.status === "rejected") {
                preserveResources();
                fixtureEvidence.cleanupConfirmed = false;
                throw new OperationError("cleanup", "cleanup-unconfirmed");
              }
              fixtureEvidence.cleanupConfirmed = true;
            })());
          const release = async () => {
            const results = await Promise.allSettled([
              releaseFixture(),
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
              if (!options.gatewayOnly) {
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
                  if (!closingFixture) {
                    fixtureAbort.abort();
                  }
                  rejectPort(new Error("mock-exited"));
                },
                (error: unknown) => {
                  mockFailed = true;
                  if (!closingFixture) {
                    fixtureAbort.abort();
                  }
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
                await phase("gateway-start", () => instance!.startGateway());
                instance.child?.once("exit", gatewayExit);
                requireLiveFixture();
              } catch (error) {
                if (hasUnjoinedWork(error)) {
                  preserveResources();
                }
                throw operationError("gateway-start", error);
              } finally {
                fixtureEvidence.readiness = instance?.readiness?.slice(-2).map((entry) => ({
                  outcome: entry.outcome,
                  elapsedMs: entry.elapsedMs,
                  attempts: entry.attempts,
                  childExitCode: entry.child.exitCode,
                  probes: entry.probes
                    .slice(-4)
                    .map(({ phase: probePhase, elapsedMs, status, ready, error }) => ({
                      phase: probePhase,
                      elapsedMs,
                      status,
                      ready,
                      error,
                    })),
                }));
              }
              const readyInstance = instance;
              const rpcEvidence = {
                authenticated: false,
                dispatchEntered: false,
                responseReceived: false,
              };
              fixtureEvidence.setupRpc = rpcEvidence;
              try {
                // The ready Gateway owns credential issuance; avoid another CLI startup beside the simulator.
                const setup = await phase("setup-code", () =>
                  callGateway<DevicePairSetupCodeResult>({
                    config: {},
                    configPath: readyInstance.configPath,
                    url: readyInstance.url,
                    token: readyInstance.gatewayToken,
                    ignoreEnvUrlOverride: true,
                    deviceIdentity: null,
                    sharedStateMode: "read-only",
                    method: "device.pair.setupCode",
                    params: { publicUrl: readyInstance.url, includeQr: false },
                    timeoutMs: 30_000,
                    signal: fixtureSignal,
                    onHelloOk: () => {
                      rpcEvidence.authenticated = true;
                    },
                    assertDispatchCurrent: () => {
                      rpcEvidence.dispatchEntered = true;
                    },
                  }),
                );
                rpcEvidence.responseReceived = true;
                setupCode = setup.setupCode;
              } catch (error) {
                requireLiveFixture();
                if (isGatewayTransportError(error) && error.kind === "timeout") {
                  const failure = new OperationError("setup-code", "timeout");
                  failure.diagnostic.context.push(
                    `rpc-authenticated:${rpcEvidence.authenticated}`,
                    `rpc-dispatch-entered:${rpcEvidence.dispatchEntered}`,
                  );
                  if (typeof error.requestDispatched === "boolean") {
                    failure.diagnostic.context.push(
                      `rpc-request-dispatched:${error.requestDispatched}`,
                    );
                  }
                  throw failure;
                }
                if (hasUnjoinedWork(error)) {
                  preserveResources();
                }
                throw operationError("setup-code", error);
              }
              if (!setupCode.trim()) {
                throw new OperationError("setup-code", "failed");
              }
            },
            async test(test) {
              if (!instance || !udid || !setupCode) {
                throw new Error("trial-not-prepared");
              }
              if (test === IOS_RELEASE_TESTS[1]) {
                requireLiveFixture();
                await phase("cleanup", releaseFixture);
              }
              const resultBundle = path.join(
                root,
                `trial-${index}-${IOS_RELEASE_TESTS.indexOf(test)}.xcresult`,
              );
              const fixture = instance;
              if (test === IOS_RELEASE_TESTS[0]) {
                requireLiveFixture();
              }
              try {
                await command(
                  "native-test",
                  "xcodebuild",
                  [
                    "-xctestrun",
                    xctestrunPath,
                    "-parallel-testing-enabled",
                    "NO",
                    "-destination",
                    `platform=iOS Simulator,id=${udid}`,
                    "-resultBundlePath",
                    resultBundle,
                    "-collect-test-diagnostics",
                    "never",
                    `-only-testing:${test}`,
                    "test-without-building",
                  ],
                  {
                    env:
                      test === IOS_RELEASE_TESTS[0]
                        ? testRunnerEnv(setupCode.trim())
                        : {
                            TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY: "0",
                            TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE: "",
                          },
                    timeoutMs: 600_000,
                    signal: test === IOS_RELEASE_TESTS[0] ? fixtureSignal : options.signal,
                    captureChatFailure:
                      test === IOS_RELEASE_TESTS[0]
                        ? async () => {
                            const facts = new Set<string>();
                            const logs = fixture.logs();
                            for (const stage of ["start", "first_event", "completed", "error"]) {
                              if (logs.includes(`[responses] ${stage} `)) {
                                facts.add(`model-any-request-stage:${stage}`);
                              }
                            }
                            const [requests, history, appLog] = await Promise.allSettled([
                              readFile(requestLog, "utf8"),
                              callGateway<unknown>({
                                config: {},
                                configPath: fixture.configPath,
                                url: fixture.url,
                                token: fixture.gatewayToken,
                                ignoreEnvUrlOverride: true,
                                deviceIdentity: null,
                                sharedStateMode: "read-only",
                                method: "chat.history",
                                params: { sessionKey: "main", limit: 20, maxBytes: 50_000 },
                                timeoutMs: 5_000,
                                signal: options.signal,
                              }),
                              (async () => {
                                const bundleID = await command(
                                  "app-diagnostics",
                                  "/usr/bin/plutil",
                                  [
                                    "-extract",
                                    "CFBundleIdentifier",
                                    "raw",
                                    "-o",
                                    "-",
                                    path.join(
                                      derivedDataPath,
                                      "Build/Products/Debug-iphonesimulator/OpenClaw.app/Info.plist",
                                    ),
                                  ],
                                  { timeoutMs: 5_000 },
                                );
                                const container = await command(
                                  "app-diagnostics",
                                  "xcrun",
                                  ["simctl", "get_app_container", udid!, bundleID, "data"],
                                  { timeoutMs: 5_000 },
                                );
                                return readFile(
                                  path.join(container, "Library/Caches/openclaw-gateway.log"),
                                  "utf8",
                                );
                              })(),
                            ]);
                            if (appLog.status === "fulfilled") {
                              if (
                                appLog.value.includes(
                                  "] chat.send skipped before dispatch: route changed",
                                )
                              ) {
                                facts.add("app-send-stage:dispatch-route-changed");
                              }
                              for (const [event, stage] of [
                                ["send invoked", "invoked"],
                                ["send ignored", "ignored"],
                                ["send queued offline", "offline-outbox"],
                                ["send routed behind outbox", "ordered-outbox"],
                                ["send queued sessionKey=", "optimistic-message"],
                                ["transport send start", "transport-start"],
                                ["transport send accepted", "transport-accepted"],
                                ["send delivery unconfirmed", "delivery-unconfirmed"],
                                ["send queued after route change", "route-changed"],
                                ["send failed", "failed"],
                              ]) {
                                if (appLog.value.includes(`] chat.ui ${event}`)) {
                                  facts.add(`app-send-stage:${stage}`);
                                }
                              }
                              facts.add("app-evidence-read");
                            } else {
                              facts.add("app-evidence-unavailable");
                            }
                            try {
                              if (requests.status !== "fulfilled") {
                                throw new Error("request-log-unavailable");
                              }
                              const lastMarker = (text: string) =>
                                [
                                  ...text.matchAll(/\bOPENCLAW_E2E_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/gu),
                                ].at(-1)?.[0];
                              const markerStage = (marker: string | undefined) =>
                                CHAT_MARKERS.find(([, prefix]) =>
                                  marker?.startsWith(prefix),
                                )?.[0] ?? "other";
                              for (const line of requests.value.trim().split("\n").slice(-20)) {
                                const request: unknown = JSON.parse(line);
                                if (
                                  !isRecord(request) ||
                                  request.path !== "/v1/responses" ||
                                  typeof request.body !== "string"
                                ) {
                                  continue;
                                }
                                const body: unknown = JSON.parse(request.body);
                                if (!isRecord(body) || body.model !== "ios-e2e") {
                                  continue;
                                }
                                const input = Array.isArray(body.input) ? body.input : [];
                                const user = input
                                  .map(readMockUserText)
                                  .findLast((text) => text !== undefined);
                                const userMarker = lastMarker(user ?? "");
                                const tailMarker = lastMarker(request.body);
                                facts.add(`provider-latest-user:${markerStage(userMarker)}`);
                                facts.add(`provider-body-tail:${markerStage(tailMarker)}`);
                                facts.add(
                                  `provider-marker-match:${userMarker !== undefined && userMarker === tailMarker}`,
                                );
                              }
                              facts.add("provider-evidence-read");
                            } catch {
                              facts.add("provider-evidence-unavailable");
                            }
                            if (
                              history.status === "fulfilled" &&
                              isRecord(history.value) &&
                              Array.isArray(history.value.messages)
                            ) {
                              for (const message of history.value.messages) {
                                if (
                                  !isRecord(message) ||
                                  (message.role !== "user" && message.role !== "assistant")
                                ) {
                                  continue;
                                }
                                const content = JSON.stringify(message.content) ?? "";
                                for (const [stage, marker] of CHAT_MARKERS) {
                                  if (content.includes(marker)) {
                                    facts.add(`history-${message.role}:${stage}`);
                                  }
                                }
                              }
                              facts.add("history-evidence-read");
                            } else {
                              facts.add("history-evidence-unavailable");
                            }
                            return [...facts];
                          }
                        : undefined,
                  },
                );
              } catch (error) {
                if (test === IOS_RELEASE_TESTS[0]) {
                  requireLiveFixture();
                }
                throw error;
              }
              if (test === IOS_RELEASE_TESTS[0]) {
                requireLiveFixture();
              }
              if (test === IOS_RELEASE_TESTS[0]) {
                await phase("provider-rpc", async () => {
                  const requests = (await readFile(requestLog, "utf8")).trim().split("\n");
                  const received: (string | undefined)[] = [];
                  for (const line of requests) {
                    const request: unknown = JSON.parse(line);
                    if (
                      !isRecord(request) ||
                      request.path !== "/v1/responses" ||
                      typeof request.body !== "string"
                    ) {
                      continue;
                    }
                    const body: unknown = JSON.parse(request.body);
                    if (!isRecord(body) || body.model !== "ios-e2e") {
                      continue;
                    }
                    const latestUser = Array.isArray(body.input)
                      ? body.input.map(readMockUserText).findLast((text) => text !== undefined)
                      : undefined;
                    const userText =
                      latestUser === undefined ? undefined : stripEnvelope(latestUser);
                    received.push(
                      CHAT_MARKERS.find(
                        ([, marker]) =>
                          userText === `Reply exactly with ${marker} and no other text.`,
                      )?.[0],
                    );
                  }
                  fixtureEvidence.providerRequestCount = received.length;
                  fixtureEvidence.providerMessages = CHAT_MARKERS.map(([stage]) => ({
                    stage,
                    received: received.includes(stage),
                  }));
                  if (
                    received.length !== CHAT_MARKERS.length ||
                    CHAT_MARKERS.some(([stage], requestIndex) => received[requestIndex] !== stage)
                  ) {
                    throw new OperationError("provider-rpc", "failed");
                  }
                });
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
