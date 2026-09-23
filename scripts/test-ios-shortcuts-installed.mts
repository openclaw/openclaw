import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/api.js";
import { MODEL_REF } from "../test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js";
import { runProfileWireProof } from "../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import {
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_WRITER_SCOPES,
} from "../test/e2e/qa-lab/runtime/skill-library-wire-fixture.js";
import { startQaGatewayRpcProxy } from "../test/fixtures/qa-gateway-rpc-proxy.mjs";
import { createBoundedChildOutput } from "../test/helpers/bounded-child-output.js";
import { runQaGatewayFixture } from "../test/helpers/qa-gateway-cleanup.js";
import { nativeUIPhases, type NativeUIKind } from "./lib/installed-native-ui-contract.mts";
import type { InstalledNativeUIReceipt } from "./lib/installed-native-ui-driver.mts";
import {
  assertInstalledIntentRegistration,
  createInstalledShortcutsMatrix,
  installedAutomaticCases,
  installedExplicitCases,
} from "./lib/installed-shortcuts-matrix.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const proofCondition = "OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF";
const selectedTest = "InstalledShortcutsUITests/testInstalledAutomaticRunOpeningPreservesOrigin";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const diagnosticTailBytes = 64 * 1024;
type InstalledCommandState = {
  phases: string[];
  nativePhases?: Record<NativeUIKind, string[]>;
  joinedCommands: number;
  unjoinedWork: boolean;
};
type InstalledCommandOptions = {
  timeoutMs?: number;
  capture?: boolean;
  ui?: boolean;
  nativeUI?: NativeUIKind;
  env?: NodeJS.ProcessEnv;
};
export type InstalledCommandDiagnostic = {
  command: number;
  phase: string;
  bin: string;
  args: string[];
  exitCode: number | null;
  stdout: { bytes: number; tail: string; truncated: boolean };
  stderr: { bytes: number; tail: string; truncated: boolean };
  error?: string;
  unjoinedWork: boolean;
};
function privateError(error: unknown) {
  const tail = createBoundedChildOutput(diagnosticTailBytes);
  tail.append(
    inspect(error, {
      depth: 8,
      maxStringLength: 8192,
      maxArrayLength: 64,
      customInspect: false,
      getters: false,
    }),
  );
  return tail.text();
}

/** Command evidence stays private even when compilation fails before xcresult exists. */
export function createInstalledCommandRunner(
  root: string,
  state: InstalledCommandState,
  phase: () => string,
  writeDiagnostic: (record: InstalledCommandDiagnostic) => Promise<void>,
) {
  const phases = ["onboarded", ...installedAutomaticCases, ...installedExplicitCases, "complete"];
  let commands = 0;
  const attemptedNative = new Set<NativeUIKind>();
  return async (bin: string, args: string[], options: InstalledCommandOptions = {}) => {
    assert(++commands <= 64, "Installed command inventory exceeded its bound");
    assert(!(options.ui && options.nativeUI), "UI proof inventories must remain separate");
    const nativeExpected = options.nativeUI ? nativeUIPhases(options.nativeUI) : undefined;
    const nativeObserved = options.nativeUI
      ? (state.nativePhases ??= { phone: [], tablet: [] })[options.nativeUI]
      : undefined;
    if (options.nativeUI) {
      assert(!attemptedNative.has(options.nativeUI), "Native UI selector was already invoked");
      attemptedNative.add(options.nativeUI);
      assert.equal(nativeObserved!.length, 0, "Native UI selector already has evidence");
    }
    const abort = new AbortController();
    const stdout = createBoundedChildOutput(diagnosticTailBytes);
    const stderr = createBoundedChildOutput(diagnosticTailBytes);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let output = "";
    let overflow = false;
    let invalidPhase = false;
    let exitCode: number | null = null;
    let failure: unknown;
    return await runQaGatewayFixture(
      async () => {
        try {
          exitCode = await runManagedCommand({
            bin,
            args,
            cwd: root,
            env: options.env,
            timeoutMs: options.timeoutMs ?? 30_000,
            signal: abort.signal,
            requireProcessTreeExit: true,
            stdio: ["ignore", "pipe", "pipe"],
            onReady(child) {
              child.stderr?.on("data", (bytes: Buffer) => {
                stderrBytes += bytes.length;
                stderr.append(bytes);
              });
              child.stdout?.on("data", (bytes: Buffer) => {
                stdoutBytes += bytes.length;
                stdout.append(bytes);
                if (!options.capture && !options.ui && !options.nativeUI) {
                  return;
                }
                output += bytes.toString();
                if (options.ui || options.nativeUI) {
                  const lines = output.split("\n");
                  output = lines.pop() ?? "";
                  for (const line of lines) {
                    if (options.nativeUI) {
                      const trimmed = line.trim();
                      if (!trimmed.startsWith("[ios-native-ui]")) {
                        continue;
                      }
                      const native = trimmed.match(/^\[ios-native-ui\] phase=([a-z:-]+)$/);
                      if (!native || native[1] !== nativeExpected![nativeObserved!.length]) {
                        invalidPhase = true;
                        abort.abort();
                      } else {
                        nativeObserved!.push(native[1]!);
                        process.stdout.write(trimmed + "\n");
                      }
                      continue;
                    }
                    const match = line
                      .trim()
                      .match(/^\[ios-shortcuts-installed\] phase=([a-z-]+)$/);
                    if (match) {
                      if (match[1] !== phases[state.phases.length]) {
                        invalidPhase = true;
                        abort.abort();
                      } else {
                        state.phases.push(match[1]!);
                        process.stdout.write(line.trim() + "\n");
                      }
                    }
                  }
                }
                if (Buffer.byteLength(output) > 1024 * 1024) {
                  overflow = true;
                  abort.abort();
                }
              });
            },
          });
          state.joinedCommands += 1;
          assert(
            !overflow && !invalidPhase && exitCode === 0,
            "Installed command failed during " + phase() + ": exit " + exitCode,
          );
          if (options.nativeUI) {
            assert(!output.includes("[ios-native-ui]"), "Unterminated native UI protocol row");
            assert.deepEqual(nativeObserved, nativeExpected, "Native UI inventory incomplete");
          }
          return output.trim();
        } catch (error) {
          failure = error;
          state.unjoinedWork ||= hasUnjoinedWork(error);
          throw error;
        }
      },
      async () => {
        await writeDiagnostic({
          command: commands,
          phase: phase(),
          bin,
          args,
          exitCode,
          stdout: {
            bytes: stdoutBytes,
            tail: stdout.text(),
            truncated: stdoutBytes > diagnosticTailBytes,
          },
          stderr: {
            bytes: stderrBytes,
            tail: stderr.text(),
            truncated: stderrBytes > diagnosticTailBytes,
          },
          ...(failure === undefined ? {} : { error: privateError(failure) }),
          unjoinedWork: state.unjoinedWork,
        });
      },
    );
  };
}

async function main() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(
    process.argv.length,
    7,
    "Expected receipt --matrix automatic-run-opening --target-sha SHA",
  );
  assert.deepEqual(process.argv.slice(3, 6), ["--matrix", "automatic-run-opening", "--target-sha"]);
  const targetSHA = process.argv[6]!;
  assert.match(targetSHA, /^[a-f0-9]{40}$/);
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_JOB);
  const root = await fs.realpath(process.cwd());
  const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
  const receiptPath = path.resolve(process.argv[2]!);
  assert.equal(await fs.realpath(path.dirname(receiptPath)), runnerTemp);
  const receiptFile = await fs.open(receiptPath, "wx", 0o600);
  const receipt = {
    sourceSHA: targetSHA,
    sourceTree: "",
    workflowSHA: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job: process.env.GITHUB_JOB,
    scope: "installed-ios-automatic-run-opening",
    macOS: "",
    xcode: "",
    runtime: "",
    appSHA256: "",
    gatewaySourceSHA: "",
    proofBuildConditionVerified: false,
    ordinaryBuildConditionExcluded: false,
    metadata: [] as Array<{ bytes: number; sha256: string; status: string }>,
    metadataRegistrationVerified: false,
    effectiveIntentBehaviorVerified: false,
    nodeOperatorHandoffVerified: false,
    nativeProfileVerified: false,
    phases: [] as string[],
    nativePhases: { phone: [], tablet: [] } as Record<NativeUIKind, string[]>,
    nativeUI: [] as InstalledNativeUIReceipt[],
    cases: [] as Array<Record<string, unknown>>,
    selectedTest,
    testResult: "NotRun",
    joinedCommands: 0,
    fixtureClosed: false,
    simulatorShutdown: false,
    simulatorDeleted: false,
    simulatorRetained: false,
    unjoinedWork: false,
    completed: false,
    failedPhase: "",
  };
  let phase = "admission";
  let simulator: string | undefined;
  const failures: unknown[] = [];
  let diagnostics: Awaited<ReturnType<typeof fs.open>> | undefined;
  const phases = ["onboarded", ...installedAutomaticCases, ...installedExplicitCases, "complete"];

  const command = createInstalledCommandRunner(
    root,
    receipt,
    () => phase,
    async (record) => {
      assert(diagnostics);
      await diagnostics.writeFile(JSON.stringify(record) + "\n");
    },
  );
  const read = (bin: string, args: string[]) => command(bin, args, { capture: true });
  try {
    const scratch = await fs.mkdtemp(path.join(runnerTemp, "ios-shortcuts-"));
    diagnostics = await fs.open(path.join(scratch, "commands.jsonl"), "wx", 0o600);
    assert.equal(await read("git", ["rev-parse", "HEAD"]), targetSHA);
    receipt.sourceTree = await read("git", ["rev-parse", "HEAD^{tree}"]);
    await command("git", ["diff", "--quiet"]);
    await command("git", ["diff", "--cached", "--quiet"]);
    receipt.macOS = await read("sw_vers", ["-productVersion"]);
    receipt.xcode = await read("xcodebuild", ["-version"]);
    assert.match(receipt.xcode, /^Xcode 27\.0\nBuild version \S+$/);
    const buildInfo = JSON.parse(
      await fs.readFile(path.join(root, "dist/build-info.json"), "utf8"),
    ) as { commit?: string };
    assert.equal(buildInfo.commit, targetSHA);
    receipt.gatewaySourceSHA = buildInfo.commit!;
    phase = "physical-device-preflight";
    const physicalPath = path.join(scratch, "devices.json");
    await command("xcrun", [
      "devicectl",
      "list",
      "devices",
      "--quiet",
      "--timeout",
      "15",
      "--json-output",
      physicalPath,
    ]);
    const physical = JSON.parse(await fs.readFile(physicalPath, "utf8")) as {
      result?: { devices?: unknown[] };
    };
    assert(Array.isArray(physical.result?.devices));
    assert.equal(physical.result.devices.length, 0, "Physical device present; refusing allocation");
    await fs.rm(physicalPath);

    phase = "owned-simulator";
    const inventory = JSON.parse(await read("xcrun", ["simctl", "list", "--json"])) as {
      runtimes: Array<{
        identifier: string;
        version: string;
        platform: string;
        isAvailable: boolean;
        supportedDeviceTypes: Array<{ productFamily: string; identifier: string }>;
      }>;
      devices: Record<string, Array<{ name: string }>>;
    };
    const runtime = inventory.runtimes
      .filter(
        (entry) =>
          entry.isAvailable && entry.platform === "iOS" && /^27(?:\.|$)/.test(entry.version),
      )
      .toSorted((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
    const deviceType = runtime?.supportedDeviceTypes.find(
      (entry) => entry.productFamily === "iPhone",
    );
    assert(runtime && deviceType, "No supported iOS27 iPhone runtime");
    const suffix = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    const name = `OpenClaw Automatic Run ${suffix}`;
    assert(
      !Object.values(inventory.devices)
        .flat()
        .some((entry) => entry.name === name),
    );
    const created = await read("xcrun", [
      "simctl",
      "create",
      name,
      deviceType.identifier,
      runtime.identifier,
    ]);
    assert.match(created, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    simulator = created;
    // This is a separate new fixture, never the shared job simulator.
    assert.notEqual(created, process.env.IOS_SIMULATOR_ID);
    receipt.runtime = runtime.identifier;
    await command("xcrun", ["simctl", "bootstatus", created, "-b"], { timeoutMs: 180_000 });
    await command("xcrun", ["simctl", "launch", created, "com.apple.shortcuts"]);

    phase = "proof-build";
    await command("/bin/bash", ["scripts/ios-write-version-xcconfig.sh"]);
    await command(process.execPath, ["scripts/ios-write-swift-filelist.mjs"]);
    await command("xcodegen", [
      "generate",
      "--spec",
      "apps/ios/project.yml",
      "--project",
      "apps/ios",
    ]);
    const derived = path.join(scratch, "DerivedData");
    const bundleBase = `ai.openclaw.siri-proof.${process.env.GITHUB_RUN_ID}`;
    const common = [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClawUITests",
      "-destination",
      `platform=iOS Simulator,id=${created}`,
      "-derivedDataPath",
      derived,
      "-parallel-testing-enabled",
      "NO",
      "CODE_SIGNING_ALLOWED=NO",
      `OPENCLAW_APP_BUNDLE_ID=${bundleBase}`,
      `OPENCLAW_APP_GROUP_ID=group.${bundleBase}`,
    ];
    type Settings = { target: string; buildSettings: Record<string, string> };
    const settings = async (args: string[]) =>
      JSON.parse(await read("xcodebuild", [...args, "-showBuildSettings", "-json"])) as Settings[];
    for (const configuration of ["Debug", "Release"]) {
      const ordinary = await settings([...common, "-configuration", configuration]);
      assert(ordinary.some((entry) => entry.target === "OpenClaw"));
      assert(
        ordinary.every(
          (entry) =>
            !(entry.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? "")
              .split(/\s+/)
              .includes(proofCondition),
        ),
      );
    }
    receipt.ordinaryBuildConditionExcluded = true;
    const buildArgs = [
      ...common,
      "-configuration",
      "Debug",
      `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG ${proofCondition}`,
    ];
    await command("xcodebuild", [...buildArgs, "build-for-testing"], { timeoutMs: 40 * 60_000 });
    const products = (await settings(buildArgs)).filter((entry) => entry.target === "OpenClaw");
    assert.equal(products.length, 1);
    const product = products[0]!.buildSettings;
    for (const flag of ["DEBUG", proofCondition]) {
      assert(product.SWIFT_ACTIVE_COMPILATION_CONDITIONS?.split(/\s+/).includes(flag));
    }
    receipt.proofBuildConditionVerified = true;
    const app = await fs.realpath(path.join(product.TARGET_BUILD_DIR!, product.FULL_PRODUCT_NAME!));
    assert(app.startsWith(`${await fs.realpath(derived)}/`));
    const plist = path.join(app, "Info.plist");
    assert.equal(
      await read("plutil", ["-extract", "OpenClawGitCommit", "raw", "-o", "-", plist]),
      targetSHA,
    );
    assert.equal(
      await read("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]),
      `${bundleBase}.debug`,
    );
    receipt.appSHA256 = hash(
      await fs.readFile(path.join(product.TARGET_BUILD_DIR!, product.EXECUTABLE_PATH!)),
    );
    await command("git", ["diff", "--quiet"]);
    await command("git", ["diff", "--cached", "--quiet"]);

    phase = "generated-metadata";
    // The real extraction stays private beside its compiled app. Unknown
    // registration schemas refuse proof; defaults and editor visibility use UI.
    const metadataPath = path.join(app, "Metadata.appintents", "extract.actionsdata");
    const metadataBytes = await fs.readFile(metadataPath);
    assert(metadataBytes.length > 0 && metadataBytes.length <= 8 * 1024 * 1024);
    receipt.metadata.push({
      bytes: metadataBytes.length,
      sha256: hash(metadataBytes),
      status: "unqualified",
    });
    assertInstalledIntentRegistration(JSON.parse(metadataBytes.toString()));
    receipt.metadata[0]!.status = "registration-verified";
    receipt.metadataRegistrationVerified = true;

    phase = "installed-fixture";
    await runProfileWireProof(
      () => startQaMockOpenAiServer({ modelRefs: [MODEL_REF] }),
      async (fixture) => {
        const token = randomUUID();
        const proxy = await startQaGatewayRpcProxy({
          backendPort: fixture.instance.port,
          repoRoot: root,
          token,
          observeMobileHandoff: true,
          observeNativeActions: true,
          observedMethods: ["users.self", "agent.wait"],
          upstreamHeaders: {
            "x-forwarded-user": SKILL_LIBRARY_ALICE,
            "x-forwarded-for": "198.51.100.40",
            "x-forwarded-proto": "http",
            "x-forwarded-host": `127.0.0.1:${fixture.instance.port}`,
            "x-openclaw-scopes": SKILL_LIBRARY_WRITER_SCOPES.join(","),
          },
        });
        let matrix: Awaited<ReturnType<typeof createInstalledShortcutsMatrix>> | undefined;
        await runQaGatewayFixture(
          async () => {
            try {
              matrix = await createInstalledShortcutsMatrix(fixture, proxy, token, suffix);
              const setup = await fixture.admin.request<{ setupCode: string }>(
                "device.pair.setupCode",
                {
                  publicUrl: proxy.url,
                  includeQr: false,
                  bootstrapProfile: "limited",
                },
              );
              const gateway = new URL(proxy.url);
              assert.equal(gateway.protocol, "ws:");
              assert.equal(gateway.hostname, "127.0.0.1");
              const descriptor = {
                setupCode: setup.setupCode,
                profileID: fixture.aliceId,
                gatewayID: `manual|127.0.0.1|${gateway.port}`,
                scenarios: matrix.scenarios,
                controlURL: matrix.controlURL,
              };
              phase = "installed-ui";
              const resultPath = path.join(scratch, "InstalledShortcuts.xcresult");
              await command(
                "xcodebuild",
                [
                  ...buildArgs,
                  `-only-testing:OpenClawUITests/${selectedTest}`,
                  "-resultBundlePath",
                  resultPath,
                  "test-without-building",
                ],
                {
                  timeoutMs: 20 * 60_000,
                  ui: true,
                  env: {
                    ...process.env,
                    TEST_RUNNER_OPENCLAW_IOS_SHORTCUTS_FIXTURE: JSON.stringify(descriptor),
                  },
                },
              );
              assert.deepEqual(receipt.phases, phases);
              matrix.verifyComplete();
              receipt.effectiveIntentBehaviorVerified = true;
              receipt.cases = matrix.receipts();
              const tests = JSON.parse(
                await read("xcrun", [
                  "xcresulttool",
                  "get",
                  "test-results",
                  "tests",
                  "--path",
                  resultPath,
                ]),
              ) as { testNodes: TestNode[] };
              type TestNode = {
                nodeType: string;
                nodeIdentifier?: string;
                result?: string;
                children?: TestNode[];
              };
              const walk = (nodes: TestNode[]): TestNode[] =>
                nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
              const cases = walk(tests.testNodes).filter((node) => node.nodeType === "Test Case");
              assert.equal(cases.length, 1);
              assert(cases[0]!.nodeIdentifier?.replace(/\(\)$/, "").endsWith(selectedTest));
              assert.equal(cases[0]!.result, "Passed");
              receipt.testResult = "Passed";
              const events = matrix.bootstrapEvents();
              const node = events.find(
                (event) =>
                  event.kind === "connect-request" &&
                  event.clientId === "openclaw-ios" &&
                  event.role === "node" &&
                  event.usesBootstrapToken,
              );
              assert(node && typeof node.deviceId === "string");
              const hello = events.find(
                (event) => event.kind === "connect-success" && event.connection === node.connection,
              );
              assert.equal(hello?.authMethod, "bootstrap-token");
              assert.deepEqual(hello.handoffRoles, ["node", "operator"]);
              const operator = events.find(
                (event) =>
                  event.kind === "connect-request" &&
                  event.role === "operator" &&
                  event.deviceId === node.deviceId &&
                  event.operatorHandoffMatched,
              );
              assert(operator);
              const operatorHello = events.find(
                (event) =>
                  event.kind === "connect-success" && event.connection === operator.connection,
              );
              assert.equal(operatorHello?.authMethod, "trusted-proxy");
              const scopes: unknown = operatorHello?.scopes;
              assert(
                Array.isArray(scopes) &&
                  scopes.every((scope: unknown): scope is string => typeof scope === "string"),
              );
              assert.deepEqual(
                scopes.toSorted((a, b) => a.localeCompare(b)),
                SKILL_LIBRARY_WRITER_SCOPES.toSorted((a, b) => a.localeCompare(b)),
              );
              receipt.nodeOperatorHandoffVerified = true;
              assert(
                events.some(
                  (event) =>
                    event.kind === "native-profile" &&
                    event.connection === operator.connection &&
                    event.profileId === fixture.aliceId,
                ),
              );
              receipt.nativeProfileVerified = true;
            } catch (error) {
              receipt.unjoinedWork ||= hasUnjoinedWork(error);
              throw error;
            }
          },
          async () => {
            receipt.cases = matrix?.receipts() ?? [];
            await matrix?.releaseGates();
          },
          async () => {
            if (!receipt.unjoinedWork) {
              try {
                await matrix?.stop();
              } catch (error) {
                receipt.unjoinedWork = true;
                throw error;
              }
            }
          },
          async () => {
            if (!receipt.unjoinedWork) {
              try {
                await proxy.stop();
              } catch (error) {
                receipt.unjoinedWork = true;
                throw error;
              }
            }
          },
        );
      },
      undefined,
      () => !receipt.unjoinedWork,
    );
    receipt.fixtureClosed = true;
    const { runInstalledNativeUIProof } = await import("./lib/installed-native-ui-driver.mts");
    await runInstalledNativeUIProof({
      root,
      scratch,
      buildArgs,
      appExecutable: path.join(product.TARGET_BUILD_DIR!, product.EXECUTABLE_PATH!),
      runtime,
      existingSimulator: created,
      suffix,
      command,
      state: receipt,
      setPhase: (next) => {
        phase = next;
      },
    });
    assert.equal(await read("git", ["rev-parse", "HEAD"]), targetSHA);
    await command("git", ["diff", "--quiet"]);
    await command("git", ["diff", "--cached", "--quiet"]);
    receipt.completed = true;
  } catch (error) {
    failures.push(error);
    receipt.unjoinedWork ||= hasUnjoinedWork(error);
    receipt.failedPhase = phase;
  } finally {
    if (simulator && !receipt.unjoinedWork) {
      try {
        await command("xcrun", ["simctl", "shutdown", simulator]);
        receipt.simulatorShutdown = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (simulator && !receipt.unjoinedWork) {
      try {
        await command("xcrun", ["simctl", "delete", simulator]);
        receipt.simulatorDeleted = true;
      } catch (error) {
        failures.push(error);
      }
    }
    receipt.simulatorRetained = Boolean(simulator && !receipt.simulatorDeleted);
    receipt.completed &&=
      failures.length === 0 && !receipt.unjoinedWork && !receipt.simulatorRetained;
    if (!receipt.completed) {
      receipt.failedPhase ||= "cleanup";
    }
    try {
      await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      failures.push(error);
    }
    try {
      await receiptFile.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (failures.length) {
        await diagnostics?.writeFile(
          JSON.stringify({ phase, errors: failures.map(privateError) }) + "\n",
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await diagnostics?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length) {
    throw new AggregateError(failures, "Installed iOS proof failed");
  }
  assert(receipt.completed, "Installed iOS proof remains incomplete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write("[ios-shortcuts-installed] FAILED (exit 1)\n");
  });
}
