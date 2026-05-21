import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  getLocalHeavyCheckPressureError,
  getLocalNativeTypecheckRefusalError,
  prepareLocalHeavyCheckEnvironment,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mjs";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mjs";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mjs";

const { args: finalArgs, env: policyEnv } = applyLocalTsgoPolicy(
  process.argv.slice(2),
  resolveLocalHeavyCheckEnv(process.env),
);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd: process.cwd() });
const shouldRunHeavyCheck = shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, policyEnv);
const nativeTypecheckRefusalError = sparseGuardError
  ? null
  : getLocalNativeTypecheckRefusalError({
      args: finalArgs,
      env: policyEnv,
      shouldRunHeavyCheck,
      toolName: "tsgo",
    });
const releaseLock =
  policyEnv.OPENCLAW_TSGO_SKIP_LOCK === "1" ||
  sparseGuardError ||
  nativeTypecheckRefusalError ||
  policyEnv.OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD === "1" ||
  !shouldRunHeavyCheck
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env: policyEnv,
        toolName: "tsgo",
      });

try {
  const pressureGuardError =
    sparseGuardError || nativeTypecheckRefusalError || !shouldRunHeavyCheck
      ? null
      : getLocalHeavyCheckPressureError({ cwd: process.cwd(), env: policyEnv });

  if (sparseGuardError) {
    console.error(sparseGuardError);
    if (shouldSkipSparseTsgoGuardError(policyEnv)) {
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } else if (nativeTypecheckRefusalError) {
    console.error(nativeTypecheckRefusalError);
    process.exitCode = 1;
  } else if (pressureGuardError) {
    console.error(pressureGuardError);
    process.exitCode = 1;
  } else {
    const env = shouldRunHeavyCheck
      ? prepareLocalHeavyCheckEnvironment({ cwd: process.cwd(), env: policyEnv })
      : policyEnv;

    if (tsBuildInfoFile) {
      fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
    }

    const tsgo = createManagedCommandInvocation({
      args: finalArgs,
      bin: tsgoPath,
      env,
    });
    const result = spawnSync(tsgo.command, tsgo.args, {
      stdio: "inherit",
      env,
      shell: tsgo.shell,
      windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
    });

    if (result.error) {
      throw result.error;
    }

    process.exitCode = result.status ?? 1;
  }
} finally {
  releaseLock();
}
