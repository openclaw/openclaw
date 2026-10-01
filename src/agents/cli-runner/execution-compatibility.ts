import { parse as parseSemver } from "semver";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { compareValidSemver } from "../../infra/semver.js";
import type { resolveCliExecutableIdentity } from "../cli-executable-identity.js";
import {
  acquireCliRuntimeUse,
  readCliRuntimeGeneration,
  withCliBackendMaintenance,
} from "./runtime-maintenance.js";
import type { PreparedCliRunContext } from "./types.js";

/** Capture service and diagnosed-installation state before any skill or per-turn overrides. */
export function captureCliMaintenanceEnv(
  backend: PreparedCliRunContext["preparedBackend"]["backend"],
  targetEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env = sanitizeHostExecEnv({
    baseEnv: process.env,
    overrides: backend.env,
    blockPathOverrides: true,
  });
  for (const key of backend.clearEnv ?? []) {
    delete env[key];
  }
  return { ...env, ...targetEnv };
}

/** Verify the selected model, then retain installation stability until the turn ends. */
export async function prepareCliExecutionCompatibility(params: {
  context: PreparedCliRunContext;
  maintenanceEnv: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<() => void> {
  const { context, maintenanceEnv, assertCurrent } = params;
  const signal = context.params.abortSignal ?? new AbortController().signal;
  const prepare = async (allowMaintenance: boolean) => {
    const hook = context.backendResolved.prepareModelCatalog;
    if (!hook) {
      return;
    }
    const compatibility = await hook({
      command: context.preparedBackend.backend.command,
      env: maintenanceEnv,
      cwd: context.cwd ?? context.workspaceDir,
      modelIds: [context.modelId],
      reason: "routine",
      runtimeGeneration: readCliRuntimeGeneration(context.backendResolved.id),
      signal,
      assertCurrent,
      ...(allowMaintenance
        ? {
            withMaintenance: <T>(update: () => Promise<T>) =>
              withCliBackendMaintenance(context.backendResolved.id, signal, assertCurrent, update),
          }
        : {}),
    });
    assertCurrent();
    const readiness = compatibility.models[context.modelId];
    if (!readiness?.available) {
      throw new Error(
        readiness?.reason ??
          `CLI backend ${context.backendResolved.id} has not verified compatibility with ${context.modelId}`,
      );
    }
    context.cliRuntimeVersion = compatibility.runtimeVersion;
  };
  await prepare(true);
  const release = await acquireCliRuntimeUse(context.backendResolved.id, signal, assertCurrent);
  try {
    // Maintenance may have completed while admission was waiting. Recheck under
    // the read lease without admitting another update across this launch.
    await prepare(false);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export function exactToolAvailabilityError(params: {
  code: "unsupported" | "runtime-unavailable";
  isolatedCompletion: boolean;
  message: string;
}): Error {
  if (!params.isolatedCompletion) {
    return new Error(params.message);
  }
  return Object.assign(new Error(params.message), {
    name: "IsolatedCompletionRuntimeError",
    code: params.code,
  });
}

export function assertExactToolAvailabilityRuntimeVersion(params: {
  backendId: string;
  policy: NonNullable<
    PreparedCliRunContext["backendResolved"]["runtimeArtifact"]
  >["exactToolAvailabilityVersionPolicy"];
  executableIdentity: Awaited<ReturnType<typeof resolveCliExecutableIdentity>>;
  isolatedCompletion: boolean;
}): void {
  const artifact = params.executableIdentity?.runtimeArtifact;
  const packageVersion = artifact?.kind === "package-tree" ? artifact.packageVersion : undefined;
  const parsedVersion = packageVersion ? parseSemver(packageVersion) : null;
  const prereleaseChannel = parsedVersion?.prerelease[0];
  const minimumVersion =
    parsedVersion?.prerelease.length === 0
      ? params.policy?.stableMinimum
      : typeof prereleaseChannel === "string"
        ? params.policy?.prereleaseMinimums?.[prereleaseChannel]
        : undefined;
  const comparison =
    packageVersion && minimumVersion ? compareValidSemver(packageVersion, minimumVersion) : null;
  if (comparison !== null && comparison >= 0) {
    return;
  }
  throw exactToolAvailabilityError({
    code: "unsupported",
    isolatedCompletion: params.isolatedCompletion,
    message: `CLI backend ${params.backendId} requires a supported package version for exact per-run tool availability${minimumVersion ? ` (requires >=${minimumVersion}` : " (unsupported release line"}${packageVersion ? `; found ${packageVersion})` : ")"}`,
  });
}
