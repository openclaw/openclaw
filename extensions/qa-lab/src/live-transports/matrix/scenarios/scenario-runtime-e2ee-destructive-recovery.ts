import {
  createMatrixQaOpenClawCliRuntime,
  type MatrixQaCliRunResult,
} from "./scenario-runtime-cli.js";
import { buildMatrixQaCliE2eeAccountConfig } from "./scenario-runtime-e2ee-cli-config.js";
import {
  loginMatrixQaCliDevice,
  parseMatrixQaCliJson,
  type MatrixQaCliBackupRestoreStatus,
  type MatrixQaCliVerificationStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export type MatrixQaCliRuntime = Awaited<ReturnType<typeof createMatrixQaOpenClawCliRuntime>>;

export function requireMatrixQaE2eeOutputDir(context: MatrixQaScenarioContext) {
  if (!context.outputDir) {
    throw new Error("Matrix E2EE destructive QA scenarios require an output directory");
  }
  return context.outputDir;
}

function requireMatrixQaCliRuntimeEnv(context: MatrixQaScenarioContext) {
  if (!context.gatewayRuntimeEnv) {
    throw new Error(
      "Matrix E2EE destructive CLI scenarios require the gateway runtime environment",
    );
  }
  return context.gatewayRuntimeEnv;
}

export function requireMatrixQaGatewayConfigPath(context: MatrixQaScenarioContext) {
  const configPath = requireMatrixQaCliRuntimeEnv(context).OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("Matrix E2EE destructive QA scenarios require the gateway config path");
  }
  return configPath;
}

export async function createMatrixQaRecoveryCliRuntime(params: {
  accountId: string;
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  label: string;
  userId: string;
}) {
  return await createMatrixQaOpenClawCliRuntime({
    artifactLabel: params.label,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId: params.accountId,
      accessToken: params.accessToken,
      baseUrl: params.context.baseUrl,
      deviceId: params.deviceId,
      encryption: true,
      initialSyncLimit: 0,
      name: `Matrix QA ${params.label}`,
      userId: params.userId,
    }),
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    runtimeEnv: requireMatrixQaCliRuntimeEnv(params.context),
  });
}

export async function loginMatrixQaRecoveryDevice(params: {
  context: MatrixQaScenarioContext;
  deviceName: string;
  userId: string;
  password: string;
}) {
  return await loginMatrixQaCliDevice(
    params.context.baseUrl,
    params,
    params.deviceName,
    "Matrix destructive recovery",
  );
}

export async function runMatrixQaCliJson<T>(params: {
  allowNonZero?: boolean;
  args: string[];
  label: string;
  runtime: MatrixQaCliRuntime;
  stdin?: string;
  timeoutMs: number;
}) {
  const result = await params.runtime.run(params.args, {
    allowNonZero: params.allowNonZero,
    stdin: params.stdin,
    timeoutMs: params.timeoutMs,
  });
  const artifacts = await writeMatrixQaCliOutputArtifacts({
    label: params.label,
    result,
    rootDir: params.runtime.artifactDir,
  });
  return {
    artifacts,
    payload: parseMatrixQaCliJson(result) as T,
    result,
  };
}

export function assertMatrixQaCliBackupRestoreSucceeded(
  restore: MatrixQaCliBackupRestoreStatus,
  label: string,
) {
  if (restore.success !== true) {
    throw new Error(`${label} backup restore failed: ${restore.error ?? "unknown error"}`);
  }
  if (restore.backup?.keyLoadError) {
    throw new Error(
      `${label} backup restore left a backup key error: ${restore.backup.keyLoadError}`,
    );
  }
  if (restore.backup?.matchesDecryptionKey !== true) {
    throw new Error(`${label} backup restore did not load the matching backup key`);
  }
}

export function assertMatrixQaCliBackupRestoreFailed(
  restore: {
    payload: MatrixQaCliBackupRestoreStatus;
    result: Pick<MatrixQaCliRunResult, "exitCode">;
  },
  params: {
    expectedBackupVersion: string;
    failureKind: "missing-recovery-key" | "rejected-recovery-key";
    label: string;
  },
) {
  if (restore.result.exitCode === 0) {
    throw new Error(`${params.label} returned a successful exit code`);
  }
  if (restore.payload.success === true) {
    throw new Error(`${params.label} unexpectedly succeeded`);
  }
  if (!restore.payload.error) {
    throw new Error(`${params.label} failed without an actionable diagnostic`);
  }
  if (restore.payload.backupVersion !== params.expectedBackupVersion) {
    throw new Error(
      `${params.label} failed against backup ${restore.payload.backupVersion ?? "<none>"}; expected ${params.expectedBackupVersion}`,
    );
  }
  const backup = restore.payload.backup;
  const backupKeyUnusable =
    backup?.decryptionKeyCached === false ||
    backup?.matchesDecryptionKey === false ||
    Boolean(backup?.keyLoadError);
  if (!backupKeyUnusable) {
    throw new Error(`${params.label} failed without evidence that the backup key was rejected`);
  }
  // The Matrix CLI has no machine-readable backup issue code, so pin these to
  // its SDK diagnostics to keep transport/auth failures from satisfying QA.
  const error = restore.payload.error.toLowerCase();
  const keyLoadError = backup?.keyLoadError?.toLowerCase() ?? "";
  const expectedDiagnostic =
    params.failureKind === "missing-recovery-key"
      ? keyLoadError.includes("getsecretstoragekey callback returned falsey") ||
        (!keyLoadError &&
          backup?.decryptionKeyCached === false &&
          error.includes(
            "backup decryption key is not loaded on this device (secret storage did not return a key)",
          ))
      : error.includes("bad mac") ||
        ["bad mac", "backup key mismatch", "does not have the matching backup decryption key"].some(
          (expected) => keyLoadError.includes(expected),
        );
  if (!expectedDiagnostic) {
    throw new Error(`${params.label} failed without the expected ${params.failureKind} diagnostic`);
  }
}

export function isMatrixQaVerifyStatusHealthy(status: {
  payload: MatrixQaCliVerificationStatus;
  result: MatrixQaCliRunResult;
}) {
  return status.result.exitCode === 0 && status.payload.serverDeviceKnown !== false;
}

export function isMatrixQaDeletedDeviceStatus(params: {
  ownerDeviceListContainsDeletedDevice: boolean;
  status: {
    payload: MatrixQaCliVerificationStatus;
    result: MatrixQaCliRunResult;
  };
}) {
  const authInvalidated =
    params.status.result.exitCode !== 0 &&
    typeof params.status.payload.error === "string" &&
    (params.status.payload.error.includes("M_UNKNOWN_TOKEN") ||
      params.status.payload.error.toLowerCase().includes("access token"));
  const deviceMissing =
    params.status.payload.serverDeviceKnown === false ||
    !params.ownerDeviceListContainsDeletedDevice;
  return {
    authInvalidated,
    deviceMissing,
    invalidated: authInvalidated || deviceMissing,
  };
}
