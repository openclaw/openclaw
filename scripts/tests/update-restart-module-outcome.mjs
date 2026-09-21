// Production seams plus synthetic-package filesystem regression.
// Needs the repository-pinned @openclaw/fs-safe; no service or full CLI runtime.
// Node >=24: node --experimental-vm-modules --test this-file.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createDiskSwap } from "./update-restart-swap-fixture.mjs";

const sourceRoot = path.resolve(
  process.env.RESTART_SOURCE_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
// Load canonical source helpers without requiring a compiled workspace package.
const normalizationRoot = process.env.RESTART_DEPENDENCY_ROOT ?? sourceRoot;
const { z } = createRequire(path.join(normalizationRoot, "package.json"))("zod");
const { normalizeOptionalString } = await import(
  pathToFileURL(path.join(normalizationRoot, "packages/normalization-core/src/string-coerce.ts"))
    .href
);
const { collectNestedErrorCandidates } = await import(
  pathToFileURL(path.join(normalizationRoot, "packages/normalization-core/src/error-coercion.ts"))
    .href
);
const { sliceUtf16Safe, truncateUtf16Safe } = await import(
  pathToFileURL(path.join(normalizationRoot, "packages/normalization-core/src/utf16-slice.ts")).href
);
const main = process.env.RESTART_VARIANT !== "pr";
const root = "/fixture/openclaw"; // Identifier only; never accessed.
const result = () => ({
  status: "ok",
  mode: "npm",
  root,
  before: { version: "2026.9.3" },
  after: { version: "2026.9.4" },
  steps: [],
  durationMs: 0,
});
class GatewayRestartHealthError extends Error {}
class UpdateCommandRecoveryPendingError extends Error {}
class UpdateActivationTimeoutError extends Error {}

async function fixture({
  error,
  commandError,
  serviceLoadBoundaryFailure = false,
  verification = { ok: true },
  mutateExecutor = false,
  packageTransaction,
  verifyOnDisk,
  installRoot = root,
} = {}) {
  let commandFailure = commandError;
  const events = [],
    messages = [],
    completion = [],
    printed = [],
    phases = [],
    records = [],
    unexpected = [];
  let verifyCalls = 0,
    commandCalls = 0,
    assertions = 0,
    verifiedCalls = 0;
  const service = {
    readRuntime: async () => {
      if (mutateExecutor === "native-state") {
        run.executorFence = { assertCurrent() {} };
      }
      return { status: "stopped" };
    },
  };
  const run = {
    runId: "fixture-run",
    env: {},
    executorFence: {
      assertCurrent() {
        assertions++;
      },
    },
  };
  const opts = { json: true, yes: true, run };
  const assertCurrent = () => run.executorFence.assertCurrent();
  const restartContext = {
    restartScriptPath: null,
    refreshGatewayServiceEnv: false,
    gatewayServiceEnv: {},
    gatewayServiceInstallEnv: null,
    serviceUpdateVerdict: {
      kind: "owned",
      root,
      refreshDefinition: false,
      requiresInstallRootRefresh: false,
    },
    gatewayPort: 19305,
    serviceStateReadEnv: {},
    serviceMutationAllowed: true,
    skipLegacyServiceRestart: false,
  };
  const directParams = {
    shouldRestart: true,
    result: result(),
    opts,
    refreshServiceEnv: false,
    serviceEnv: {},
    serviceInstallEnv: null,
    serviceUpdateVerdict: restartContext.serviceUpdateVerdict,
    gatewayPort: 19305,
    timeoutMs: 100,
    requireRunningServiceAfterRestart: true,
    onVerified: () => {
      verifiedCalls++;
    },
  };
  // This transaction double observes the *real caller's* retirement authorization.
  // It does not claim to exercise actual package deletion or a native restart.
  const transaction = packageTransaction ?? {
    backupRoot: "/fixture/previous-package",
    async complete(options, fence) {
      fence?.();
      completion.push(options.activationVerified);
      events.push("complete:" + options.activationVerified);
    },
  };
  const finishParams = {
    ...directParams,
    root: installRoot,
    result: { ...result(), root: installRoot },
    shouldRestart: true,
    mutationStarted: true,
    installKindChanged: false,
    requestedChannel: null,
    storedChannel: null,
    channel: "stable",
    downgradeRisk: false,
    configSnapshot: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 100,
    packageTransaction: transaction,
    preManagedServiceStop: {
      stopped: true,
      running: true,
      serviceEnv: {},
      serviceMutationAllowed: true,
      serviceUpdateVerdict: restartContext.serviceUpdateVerdict,
    },
  };
  const values = {
    theme: new Proxy({}, { get: () => (value) => value }),
    normalizeOptionalString,
    resolveServiceRefreshEnv: (env) => env,
    resolveGatewayServiceManagementBlockMessageForUpdate: () => undefined,
    isPackageManagerUpdateMode: (mode) => ["npm", "pnpm", "bun"].includes(mode),
    defaultRuntime: {
      log: (value) => messages.push(value),
      error: (value) => messages.push(value),
    },
    formatErrorMessage: String,
    formatCliCommand: (value) => value,
    GatewayRestartHealthError,
    z,
    UpdateCommandRecoveryPendingError,
    UpdateActivationTimeoutError,
    GatewayServiceUpdateOwnershipError: class extends Error {},
    DEFINITION_DENIAL: /fixture-definition-denial/,
    resolveGatewayService: () => service,
    getUpdateRun: () => undefined,
    recordUpdateRunPhase: (_id, phase) => phases.push(phase),
    recordUpdateRunVerification: (_id, record) => records.push(record),
    recordUpdateRunDiagnostics: (_id, readResult) => {
      const observed = readResult();
      return { verification: { ...observed.verification, recovery: observed.recovery } };
    },
    recordUpdateRunStep: () => {},
    async runUpdatedInstallGatewayCommand(activation, command, preserve) {
      commandCalls++;
      events.push("command:" + command);
      assert.equal(command, "restart");
      assert.equal(preserve, main ? undefined : true);
      activation.assertCurrent?.();
      if (commandFailure) {
        throw commandFailure;
      }
      return "accepted";
    },
    async verifyUpdatedGateway(params) {
      verifyCalls++;
      events.push(params.purpose === "recovery" ? "recovery-verification" : "verification");
      assert.equal(params.expectedVersion, "2026.9.4");
      assert.equal(params.requireRunningService, params.purpose === "recovery" ? undefined : true);
      params.assertCurrent?.();
      if (mutateExecutor === "verification") {
        run.executorFence = { assertCurrent() {} };
      }
      if (verifyOnDisk) {
        await verifyOnDisk();
      }
      if (error) {
        throw error;
      } // The rejection reaches the real outer catch, not child stdout.
      if (verification.ok) {
        params.onVerified?.(Date.now());
      }
      return verification;
    },
    withOwnedManagedUpdateEnv: async (_env, action) => action(),
    readConfigFileSnapshot: async () => ({}),
    prepareUpdateRestart: async () => restartContext,
    convergeUpdatePlugins: async (params) => ({ resultWithPostUpdate: params.result }),
    maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async () => {},
    createWindowsTaskAutoStartGuard: () => ({}),
    rollbackFailedUpdate: async (params) => {
      events.push("rollback-unverified");
      return { result: params.result, rolledBack: false };
    },
    resolveUpdateResultNextAction: () => "Retain recovery material until health is verified.",
    completeUpdateCommandRun: (value) => value,
    printResult: (value) => printed.push(value),
    writeControlPlaneUpdateRestartSentinel: async () => {},
    markControlPlaneUpdateRestartSentinelFailure: async () => {},
    buildControlPlaneUpdateRestartHealthPendingResult: (value) => value,
    resolveManagedServiceUpdateFailureExitCode: () => 1,
    tryWriteCompletionCache: async () => {},
    PLUGIN_CAPABILITY_CONSENT_REQUIRED: "fixture-consent-required",
    createUpdateCommandFinalizationFence: () => assertCurrent,
    assertUpdateCommandPackageFinalization: async () => {},
    normalizeControlPlaneUpdateResult: (value) => value,
    isUpdateGatewayReadinessPending: (value) => value.reason === "gateway-readiness-pending",
    collectNestedErrorCandidates,
    sliceUtf16Safe,
    truncateUtf16Safe,
    withCommandProcessScope: async (action) => action(),
    readPackageVersion: async (packageRoot) => {
      assert.equal(packageRoot, installRoot);
      return "2026.9.4";
    },
    readBuiltGatewayBuildId: async () => undefined,
    readActiveGatewayLockPort: async () => 19305,
    createUpdateFailureFact: (fact) => fact,
    resolveOpenClawStateSqlitePath: () => "/fixture/state.sqlite",
    assertUpdateRecoveryAdmission: async () => {},
    readGatewayOwnerLease: async () => undefined,
  };
  const context = vm.createContext({
    process: { env: {}, stdin: { isTTY: false }, platform: "linux" },
    Date,
    Error,
    AggregateError,
    console,
  });
  const realNames = [
    "update-command-service",
    "update-command-post-update",
    "update-command-result",
    "../../infra/update-run-step",
    ...(main
      ? [
          "update-command-verification",
          "update-command-terminal",
          "update-command-terminal-publication",
          "update-command-post-update-maintenance",
          // Recovery and reporting stay real; only their I/O uses finite fixture facts.
          "update-command-failure-recovery",
          "update-command-plugins-internals",
          "../../process/exec-result",
          "../../shared/update-outcome",
          "../../infra/update-run-report",
          "../../infra/update-run-step",
          "../../infra/update-run-record",
          "../../infra/update-run-limits",
          "../../infra/update-doctor-config",
          "../../infra/update-failure-facts-format",
          "../../../packages/gateway-protocol/src/update-run-vocabulary",
          // Keep pending-load retention policy and Error identity production-owned.
          "update-command-service-load",
          "../../daemon/service-stage",
        ]
      : ["update-restart-module-error"]),
  ];
  const modules = new Map(),
    requests = new Map();
  // Evaluate complete production files. Only TypeScript syntax is transformed;
  // no function extraction, production-body rewrites, or replacement outcome logic.
  for (const name of realNames) {
    const filename = path.join(sourceRoot, "src/cli/update-cli", name + ".ts");
    const code = stripTypeScriptTypes(await fs.readFile(filename, "utf8"), {
      mode: "transform",
      sourceUrl: filename,
    });
    const mod = new vm.SourceTextModule(code, { context, identifier: filename });
    modules.set(path.basename(name) + ".js", mod);
    const imports = new Map();
    for (const match of code.matchAll(
      /(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gs,
    )) {
      const names = match[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      imports.set(match[2], [...new Set([...(imports.get(match[2]) ?? []), ...names])]);
    }
    // The historical classifier uses builtin path/url imports only.
    for (const match of code.matchAll(/import\s+(\w+)\s+from\s*["']([^"']+)["']/g)) {
      imports.set(match[2], ["default"]);
    }
    requests.set(mod.identifier, imports);
  }
  const external = new Map();
  for (const imports of requests.values()) {
    for (const [specifier, names] of imports) {
      if (!external.has(specifier)) {
        external.set(specifier, new Set());
      }
      names.forEach((name) => external.get(specifier).add(name));
    }
  }
  const stubs = new Map();
  for (const [specifier, namesSet] of external) {
    if (
      modules.has(path.basename(specifier)) &&
      path.basename(specifier) !== "update-command-verification.js"
    ) {
      continue;
    }
    const names = [...namesSet];
    const builtin = specifier.startsWith("node:") ? await import(specifier) : undefined;
    stubs.set(
      specifier,
      new vm.SyntheticModule(
        names,
        function () {
          for (const name of names) {
            const value = builtin
              ? builtin[name]
              : Object.hasOwn(values, name)
                ? values[name]
                : () => {
                    const message = "Unexpected dependency call: " + specifier + ":" + name;
                    unexpected.push(message);
                    throw new Error(unexpected.join("\n"));
                  };
            this.setExport(name, value);
          }
        },
        { context, identifier: specifier },
      ),
    );
  }
  const link = (specifier) =>
    path.basename(specifier) === "update-command-verification.js"
      ? stubs.get(specifier)
      : (modules.get(path.basename(specifier)) ?? stubs.get(specifier));
  if (main) {
    // The recorder moved out of the restart owner; keep its real ledger writes
    // while injecting only the Gateway verification seam.
    const verificationOwner = modules.get("update-command-verification.js");
    await verificationOwner.link(link);
    await verificationOwner.evaluate();
    values.recordFailedUpdateGatewayState =
      verificationOwner.namespace.recordFailedUpdateGatewayState;
    values.readFailedUpdateGatewayState = verificationOwner.namespace.readFailedUpdateGatewayState;
  }
  const entry = modules.get("update-command-post-update.js");
  await entry.link(link);
  await entry.evaluate();
  if (serviceLoadBoundaryFailure) {
    const { UpdateServiceLoadBoundaryError } = modules.get(
      "update-command-service-load.js",
    ).namespace;
    commandFailure = new UpdateServiceLoadBoundaryError("fixture service load boundary");
  }
  return {
    commandError: commandFailure,
    direct: (params) =>
      modules
        .get("update-command-service.js")
        .namespace.maybeRestartService({ ...directParams, ...params }),
    finish: () => entry.namespace.finishUpdate(finishParams),
    failureClass: modules.get("update-command-result.js").namespace.UpdateCommandFailure,
    events,
    messages,
    completion,
    printed,
    phases,
    records,
    unexpected,
    run,
    counts: () => ({ verifyCalls, commandCalls, assertions, verifiedCalls }),
  };
}

/** @type {Array<[string, () => Error]>} */
const thrownCases = [
  [
    "in-root ENOENT JS chunk",
    () =>
      Object.assign(
        new Error(`ENOENT: no such file or directory, open '${root}/dist/old-chunk.js'`),
        { code: "ENOENT", path: root + "/dist/old-chunk.js" },
      ),
  ],
  [
    "in-root ERR_MODULE_NOT_FOUND",
    () =>
      Object.assign(
        new Error(
          `Cannot find module '${root}/dist/old-chunk.js' imported from ${root}/dist/index.js`,
        ),
        { code: "ERR_MODULE_NOT_FOUND", url: "file://" + root + "/dist/old-chunk.js" },
      ),
  ],
  [
    "unrelated module",
    () =>
      Object.assign(
        new Error("Cannot find module '/unrelated/chunk.js' imported from /unrelated/index.js"),
        { code: "ERR_MODULE_NOT_FOUND" },
      ),
  ],
  [
    "in-root missing data file",
    () =>
      Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/config.json'`), {
        code: "ENOENT",
        path: root + "/config.json",
      }),
  ],
];
for (const [name, makeError] of thrownCases) {
  void test(`production restart: ${name} stays unverified`, async () => {
    const f = await fixture({ error: makeError() });
    assert.equal(await f.direct(), "failed");
    assert.equal(f.counts().verifyCalls, 1);
    assert.equal(f.counts().commandCalls, 1);
    assert.equal(f.counts().verifiedCalls, 0);
    assert.equal(f.records.at(-1).readyz, false);
    assert.equal(f.records.at(-1).settled, false);
    assert.match(f.messages.join("\n"), /restart failed/);
    assert.doesNotMatch(
      f.messages.join("\n"),
      /restarted successfully|being restarted normally|installed version is unaffected/,
    );
    assert.deepEqual(f.unexpected, []);
  });
  void test(`production finishUpdate: ${name} retains transaction backup`, async () => {
    const f = await fixture({ error: makeError() });
    await assert.rejects(f.finish(), (error) => {
      assert.ok(error instanceof f.failureClass);
      assert.equal(error.result.status, "error");
      assert.equal(error.result.recovery.serviceRestartSafe, false);
      assert.equal(error.result.reason, "restart-unhealthy");
      return true;
    });
    assert.equal(f.counts().verifyCalls, main ? 2 : 1);
    assert.equal(f.counts().commandCalls, 1);
    assert.deepEqual(f.completion, [false]);
    assert.equal(f.printed.at(-1).status, "error");
    assert.ok(f.events.includes("rollback-unverified"));
    if (main) {
      assert.ok(f.events.indexOf("complete:false") < f.events.indexOf("recovery-verification"));
    }
    assert.deepEqual(f.unexpected, []);
  });
}
void test("production restart success requires actual verification seam success", async () => {
  const f = await fixture();
  assert.equal(await f.direct(), "ok");
  assert.equal(f.counts().verifyCalls, 1);
  assert.equal(f.counts().verifiedCalls, 1);
  assert.deepEqual(f.unexpected, []);
});
void test("production finishUpdate authorizes backup retirement only after verified success", async () => {
  const f = await fixture();
  assert.equal((await f.finish()).status, "ok");
  assert.deepEqual(f.completion, [true]);
  assert.ok(f.events.indexOf("verification") < f.events.indexOf("complete:true"));
  assert.equal(f.counts().verifyCalls, 1);
  assert.ok(!f.events.includes("rollback-unverified"));
  assert.deepEqual(f.unexpected, []);
});
void test("accepted restart without healthy successor cannot authorize retirement", async () => {
  const f = await fixture({ verification: { ok: false, summary: "successor-not-healthy" } });
  await assert.rejects(
    f.finish(),
    (error) => error instanceof f.failureClass && error.result.reason === "successor-not-healthy",
  );
  assert.deepEqual(f.completion, [false]);
  assert.equal(f.counts().verifyCalls, main ? 2 : 1);
  assert.deepEqual(f.unexpected, []);
});
if (main) {
  void test("current-main service-load boundary error propagates unchanged", async () => {
    const f = await fixture({ serviceLoadBoundaryFailure: true });
    await assert.rejects(f.direct(), (actual) => actual === f.commandError);
    assert.equal(f.counts().verifyCalls, 0);
    assert.equal(f.counts().commandCalls, 1);
    assert.deepEqual(f.unexpected, []);
  });
  for (const mutateExecutor of ["verification", "native-state"]) {
    void test(`current-main cannot publish after executor replacement during ${mutateExecutor}`, async () => {
      const f = await fixture({ error: thrownCases[0][1](), mutateExecutor });
      await assert.rejects(f.direct(), /lost its original update executor/);
      assert.equal(f.counts().verifyCalls, 1);
      assert.deepEqual(f.records, []);
      assert.deepEqual(f.unexpected, []);
    });
  }
  void test("current-main readiness pending remains distinct from verified success", async () => {
    const f = await fixture({
      verification: { ok: false, stopReason: "gateway-readiness-pending" },
    });
    assert.equal(await f.direct(), "readiness-pending");
    assert.equal(f.counts().verifiedCalls, 0);
    assert.deepEqual(f.unexpected, []);
  });
  void test("current-main health error observes successor without a second restart", async () => {
    const f = await fixture({
      commandError: new GatewayRestartHealthError("not ready at child exit"),
    });
    assert.equal(await f.direct(), "ok");
    assert.equal(f.counts().commandCalls, 1);
    assert.equal(f.counts().verifyCalls, 1);
    assert.equal(f.counts().verifiedCalls, 1);
    assert.deepEqual(f.unexpected, []);
  });
}

if (main) {
  void test("current-main still-starting keeps the restart unverified and records the reason", async () => {
    const f = await fixture({ verification: { ok: false, stopReason: "still-starting" } });
    const update = result();
    assert.equal(await f.direct({ result: update }), "readiness-pending");
    assert.equal(update.reason, "still-starting");
    assert.equal(f.counts().verifiedCalls, 0);
    assert.deepEqual(f.unexpected, []);
  });
}

// Synthetic tiny package bytes, real production transaction/filesystem owners.
// This is not authenticated Gateway health or published-driver artifact proof.
for (const failure of ["ERR_MODULE_NOT_FOUND", "ENOENT", "verified-result-control"]) {
  void test(`filesystem swap: ${failure} cannot retire an unverified backup`, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "restart-142102-"));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const disk = await createDiskSwap(
      process.env.RESTART_TRANSACTION_SOURCE_ROOT ?? sourceRoot,
      base,
    );
    let observed;
    const f = await fixture({
      installRoot: disk.root,
      // Historical callers predate the explicit executor callback. Adapt only
      // that signature; the real transaction still owns retirement decisions.
      packageTransaction: main
        ? disk.transaction
        : {
            ...disk.transaction,
            complete: (options) => disk.transaction.complete(options, () => {}),
          },
      verifyOnDisk: async () => {
        if (failure === "ERR_MODULE_NOT_FOUND") {
          try {
            await disk.oldEntry.late();
          } catch (error) {
            observed = error.code;
            throw error;
          }
          assert.fail("old hashed chunk unexpectedly survived the swap");
        }
        if (failure === "ENOENT") {
          try {
            await fs.readFile(path.join(disk.root, "dist/old-142102.mjs"));
          } catch (error) {
            observed = error.code;
            throw error;
          }
          assert.fail("old hashed chunk unexpectedly survived the swap");
        }
        const candidate = await import(
          pathToFileURL(path.join(disk.root, "dist/new-142102.mjs")).href
        );
        assert.equal(candidate.version, "2026.9.4");
      },
    });
    if (failure === "verified-result-control") {
      assert.equal((await f.finish()).status, "ok");
      await assert.rejects(fs.stat(disk.transaction.backupRoot), { code: "ENOENT" });
    } else {
      let finished, rejected;
      try {
        finished = await f.finish();
      } catch (error) {
        rejected = error;
      }
      const backupExists = await fs.stat(disk.transaction.backupRoot).then(
        () => true,
        /** @param {unknown} error */
        (error) => {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return false;
          }
          throw error;
        },
      );
      t.diagnostic(
        JSON.stringify({
          observed,
          status: finished?.status ?? rejected?.result?.status,
          backupExists,
        }),
      );
      assert.equal(observed, failure);
      assert.ok(
        rejected instanceof f.failureClass,
        "failed late import must reject the actual post-update caller",
      );
      assert.equal(rejected.result.status, "error");
      assert.equal(backupExists, true, "old package must remain available until verification");
      assert.equal(f.counts().verifiedCalls, 0);
      const backup = JSON.parse(
        await fs.readFile(path.join(disk.transaction.backupRoot, "package.json"), "utf8"),
      );
      assert.equal(backup.version, "2026.9.3");
      assert.equal(
        (
          await import(
            pathToFileURL(path.join(disk.transaction.backupRoot, "dist/old-142102.mjs")).href
          )
        ).version,
        "2026.9.3",
      );
    }
    assert.deepEqual(f.unexpected, []);
    assert.deepEqual(disk.unexpected, []);
  });
}
