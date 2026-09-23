import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { startQaMockOpenAiServer } from "../../extensions/qa-lab/api.js";
import { decodePairingSetupCode } from "../../src/pairing/setup-code.js";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../src/test-helpers/proxy-tls-fixture.js";
import { MODEL_REF } from "../../test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js";
import { runProfileWireProof } from "../../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import {
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_WRITER_SCOPES,
} from "../../test/e2e/qa-lab/runtime/skill-library-wire-fixture.js";
import { startQaGatewayRpcProxy } from "../../test/fixtures/qa-gateway-rpc-proxy.mjs";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { createInstalledCommandRunner } from "../test-ios-shortcuts-installed.mts";
import {
  assertNativeUITestResult,
  nativeUIPhases,
  nativeUISelectors,
  type NativeUIKind,
} from "./installed-native-ui-contract.mts";
import { createInstalledNativeUIMatrix } from "./installed-native-ui-matrix.mts";
import { hasUnjoinedWork } from "./managed-child-process.mts";

type Command = ReturnType<typeof createInstalledCommandRunner>;
type Runtime = {
  identifier: string;
  supportedDeviceTypes: Array<{ productFamily: string; identifier: string }>;
};
export type InstalledNativeUIReceipt = {
  kind: NativeUIKind;
  selectedTest: string;
  sourceSHA: string;
  sourceTree: string;
  gatewaySourceSHA: string;
  appSHA256: string;
  controlUIIndexSHA256: string;
  runtime: string;
  simulator?: string;
  phases: string[];
  cases: Array<Record<string, unknown>>;
  testResult: string;
  fixtureClosed: boolean;
  simulatorShutdown: boolean;
  simulatorDeleted: boolean;
  simulatorRetained: boolean;
  unjoinedWork: boolean;
  completed: boolean;
};

/** Uses the original command runner and compiled proof app. Each finite selector owns
 * a fresh simulator and fixture; no phase can borrow another selector's permissions. */
export async function runInstalledNativeUIProof(options: {
  root: string;
  scratch: string;
  buildArgs: string[];
  appExecutable: string;
  runtime: Runtime;
  existingSimulator: string;
  suffix: string;
  command: Command;
  state: {
    sourceSHA: string;
    sourceTree: string;
    gatewaySourceSHA: string;
    appSHA256: string;
    nativePhases: Record<NativeUIKind, string[]>;
    unjoinedWork: boolean;
    nativeUI: InstalledNativeUIReceipt[];
  };
  setPhase: (phase: string) => void;
}) {
  const { root, scratch, command, state } = options;
  const read = (bin: string, args: string[]) => command(bin, args, { capture: true });
  const certificate = PROXY_FIXTURE_CERTIFICATE;
  const fingerprint = new X509Certificate(certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  assert.equal(fingerprint, "5f9ad0dc31a37059b8e5c8844e234f8e2e3e191e2f74511b432efc034dc338c6");
  options.setPhase("native-ui-control-build");
  await command("pnpm", ["ui:build"], {
    timeoutMs: 40 * 60_000,
    env: { ...process.env, OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
  });
  const controlUIIndexSHA256 = createHash("sha256")
    .update(await fs.readFile(path.join(root, "dist/control-ui/index.html")))
    .digest("hex");
  for (const kind of ["phone", "tablet"] as const) {
    assert(!state.unjoinedWork, "Previous installed borrower remains unjoined");
    const row: InstalledNativeUIReceipt = {
      kind,
      selectedTest: nativeUISelectors[kind],
      sourceSHA: state.sourceSHA,
      sourceTree: state.sourceTree,
      gatewaySourceSHA: state.gatewaySourceSHA,
      appSHA256: state.appSHA256,
      controlUIIndexSHA256,
      runtime: options.runtime.identifier,
      phases: state.nativePhases[kind],
      cases: [],
      testResult: "NotRun",
      fixtureClosed: false,
      simulatorShutdown: false,
      simulatorDeleted: false,
      simulatorRetained: false,
      unjoinedWork: false,
      completed: false,
    };
    state.nativeUI.push(row);
    const errors: unknown[] = [];
    let matrix: Awaited<ReturnType<typeof createInstalledNativeUIMatrix>> | undefined;
    const proxies: Array<Awaited<ReturnType<typeof startQaGatewayRpcProxy>>> = [];
    let matrixAttempted = false;
    let borrowersClosed = false;
    const retain = (error: unknown) => {
      row.unjoinedWork = true;
      state.unjoinedWork = true;
      return error;
    };
    try {
      options.setPhase("native-ui-" + kind + "-simulator");
      const family = kind === "phone" ? "iPhone" : "iPad";
      const device = options.runtime.supportedDeviceTypes.find(
        (entry) => entry.productFamily === family,
      );
      assert(device, "No supported iOS27 " + family + " runtime");
      const name = "OpenClaw Native " + kind + " " + options.suffix;
      const inventory = JSON.parse(
        await read("xcrun", ["simctl", "list", "devices", "--json"]),
      ) as {
        devices: Record<string, Array<{ name: string }>>;
      };
      assert(
        !Object.values(inventory.devices)
          .flat()
          .some((entry) => entry.name === name),
      );
      const simulator = await read("xcrun", [
        "simctl",
        "create",
        name,
        device.identifier,
        options.runtime.identifier,
      ]);
      assert.match(simulator, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      row.simulator = simulator;
      assert.notEqual(simulator, options.existingSimulator);
      assert.notEqual(simulator, process.env.IOS_SIMULATOR_ID);
      assert.equal(state.nativeUI.filter((entry) => entry.simulator === simulator).length, 1);
      await command("xcrun", ["simctl", "bootstatus", simulator, "-b"], { timeoutMs: 180_000 });
      if (kind === "phone") {
        await command("xcrun", ["simctl", "launch", simulator, "com.apple.shortcuts"]);
      }
      const destinationIndex = options.buildArgs.indexOf("-destination");
      assert(
        destinationIndex >= 0 && options.buildArgs.lastIndexOf("-destination") === destinationIndex,
      );
      const buildArgs = [...options.buildArgs];
      buildArgs[destinationIndex + 1] = "platform=iOS Simulator,id=" + simulator;
      const proxyToken = randomUUID();
      options.setPhase("native-ui-" + kind + "-fixture");
      await runProfileWireProof(
        () => startQaMockOpenAiServer({ modelRefs: [MODEL_REF] }),
        async (fixture) => {
          assert.equal(proxies.length, 2);
          const proxy = proxies[0]!;
          // Seed sends can commit before construction returns. Unknown construction
          // outcome retains the fixture instead of pretending there was no borrower.
          matrixAttempted = true;
          try {
            matrix = await createInstalledNativeUIMatrix(
              fixture,
              proxy,
              proxyToken,
              certificate,
              kind,
              options.suffix,
            );
          } catch (error) {
            throw retain(error);
          }
          const setup = async (url: string) => {
            const result = await fixture.admin.request<{ setupCode: string }>(
              "device.pair.setupCode",
              {
                publicUrl: url,
                includeQr: false,
              },
            );
            const decoded = decodePairingSetupCode(result.setupCode);
            assert.equal(decoded.url, url);
            assert.equal(decoded.tlsFingerprint, undefined);
            assert.equal(new URL(url).protocol, "wss:");
            assert.equal(new URL(url).hostname, "127.0.0.1");
            return result.setupCode;
          };
          const descriptor = {
            kind,
            setupCode: await setup(proxy.url),
            trustSetupCode: await setup(proxies[1]!.url),
            fingerprint,
            profileID: fixture.aliceId,
            controlURL: matrix.controlURL,
            shortcutPrefix: "Native " + kind + " " + options.suffix,
            primary: matrix.primary,
            other: matrix.other,
            dashboard: matrix.dashboard,
          };
          options.setPhase("native-ui-" + kind + "-controls");
          const resultPath = path.join(scratch, "NativeControls-" + kind + ".xcresult");
          await command(
            "xcodebuild",
            [
              ...buildArgs,
              "-only-testing:OpenClawUITests/" + row.selectedTest,
              "-resultBundlePath",
              resultPath,
              "test-without-building",
            ],
            {
              timeoutMs: 20 * 60_000,
              nativeUI: kind,
              env: {
                ...process.env,
                TEST_RUNNER_OPENCLAW_IOS_NATIVE_UI_FIXTURE: JSON.stringify(descriptor),
              },
            },
          );
          assert.deepEqual(row.phases, nativeUIPhases(kind));
          matrix.verifyComplete();
          row.cases = matrix.receipts();
          const result: unknown = JSON.parse(
            await read("xcrun", [
              "xcresulttool",
              "get",
              "test-results",
              "tests",
              "--path",
              resultPath,
            ]),
          );
          assertNativeUITestResult(result, kind);
          row.testResult = "Passed";
          assert.equal(
            createHash("sha256")
              .update(await fs.readFile(options.appExecutable))
              .digest("hex"),
            row.appSHA256,
          );
        },
        async ({ instance, config }) => {
          for (let index = 0; index < 2; index += 1) {
            const proxy = await startQaGatewayRpcProxy({
              backendPort: instance.port,
              repoRoot: root,
              token: proxyToken,
              tls: { key: PROXY_FIXTURE_KEY, cert: certificate },
              observeMobileHandoff: true,
              observeNativeActions: true,
              observedMethods: ["users.self", "agent.wait", "sessions.reset", "sessions.fork"],
              upstreamHeaders: {
                "x-forwarded-user": SKILL_LIBRARY_ALICE,
                "x-forwarded-for": "198.51.100.40",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "127.0.0.1:" + instance.port,
                "x-openclaw-scopes": ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES].join(","),
              },
            });
            proxies.push(proxy);
          }
          config.logging = { ...config.logging, level: "debug" };
          const qa = config.agents?.entries?.qa;
          config.agents = {
            ...config.agents,
            entries: {
              ...config.agents?.entries,
              qa: {
                ...qa,
                tools: {
                  ...qa?.tools,
                  exec: { ...qa?.tools?.exec, mode: "ask" },
                  alsoAllow: [...new Set([...(qa?.tools?.alsoAllow ?? []), "openclaw"])],
                },
              },
            },
          };
          const control = config.gateway?.controlUi;
          config.gateway = {
            ...config.gateway,
            controlUi: {
              ...control,
              enabled: true,
              allowedOrigins: [
                ...new Set([
                  ...(control?.allowedOrigins ?? []),
                  ...proxies.map((proxy) => new URL(proxy.controlUrl).origin),
                ]),
              ],
            },
          };
        },
        () => borrowersClosed && !row.unjoinedWork && !state.unjoinedWork,
        async () => {
          if (state.unjoinedWork || row.unjoinedWork || (matrixAttempted && !matrix)) {
            throw retain(new Error("Native UI retained state for an unjoined borrower"));
          }
          await runQaGatewayFixture(
            async () => {},
            async () => {
              row.cases = matrix?.receipts() ?? [];
              try {
                await matrix?.releaseGates();
              } catch (error) {
                throw retain(error);
              }
            },
            async () => {
              if (!row.unjoinedWork) {
                try {
                  await matrix?.stop();
                } catch (error) {
                  throw retain(error);
                }
              }
            },
            async () => {
              if (!row.unjoinedWork) {
                const outcomes = await Promise.allSettled(proxies.map((proxy) => proxy.stop()));
                const rejected = outcomes.filter(
                  (result): result is PromiseRejectedResult => result.status === "rejected",
                );
                if (rejected.length) {
                  throw retain(
                    new AggregateError(
                      rejected.map((result) => result.reason),
                      "Native TLS proxy cleanup failed",
                    ),
                  );
                }
                borrowersClosed = true;
              }
            },
          );
        },
      );
      row.fixtureClosed = true;
      row.completed = true;
    } catch (error) {
      errors.push(error);
      if (hasUnjoinedWork(error) || state.unjoinedWork) {
        retain(error);
      }
    } finally {
      if (row.simulator && !row.unjoinedWork && !state.unjoinedWork) {
        try {
          await command("xcrun", ["simctl", "shutdown", row.simulator]);
          row.simulatorShutdown = true;
        } catch (error) {
          errors.push(error);
        }
        if (!state.unjoinedWork) {
          try {
            await command("xcrun", ["simctl", "delete", row.simulator]);
            row.simulatorDeleted = true;
          } catch (error) {
            errors.push(error);
          }
        }
      }
      row.simulatorRetained = Boolean(row.simulator && !row.simulatorDeleted);
      row.unjoinedWork ||= state.unjoinedWork;
      row.completed &&= errors.length === 0 && !row.simulatorRetained && !row.unjoinedWork;
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length) {
      throw new AggregateError(errors, "Native installed UI proof failed");
    }
    assert(row.completed, "Native UI selector proof is incomplete");
  }
}
