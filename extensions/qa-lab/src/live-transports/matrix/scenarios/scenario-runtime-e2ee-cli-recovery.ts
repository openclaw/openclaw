import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  assertMatrixQaCliE2eeStatus,
  assertMatrixQaCliEncryptionSetupResult,
  buildMatrixQaCliE2eeAccountConfig,
  runMatrixQaCliExpectedFailure,
} from "./scenario-runtime-e2ee-cli-config.js";
import { createMatrixQaCliE2eeSetupRuntime } from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  createMatrixQaE2eeCliOwnerClient,
  isMatrixQaCliBackupUsable,
  parseMatrixQaCliJson,
  loginMatrixQaCliDevice,
  registerMatrixQaCliE2eeAccount,
  runMatrixQaSetupCliJson,
  type MatrixQaCliEncryptionSetupStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import { ensureMatrixQaE2eeOwnDeviceVerified } from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export function runMatrixQaE2eeCliRecoveryKeySetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return runMatrixQaCliRecoveryKeyScenario(context, false);
}

export function runMatrixQaE2eeCliRecoveryKeyInvalidScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return runMatrixQaCliRecoveryKeyScenario(context, true);
}

async function runMatrixQaCliRecoveryKeyScenario(
  context: MatrixQaScenarioContext,
  invalid: boolean,
): Promise<MatrixQaScenarioExecution> {
  const accountId = invalid ? "cli-invalid-recovery-key" : "cli-recovery-key-setup";
  const scenarioId = invalid
    ? "matrix-e2ee-cli-recovery-key-invalid"
    : "matrix-e2ee-cli-recovery-key-setup";
  const name = invalid ? "Invalid Recovery Key" : "Recovery Key";
  const label = invalid ? "invalid recovery-key" : "recovery-key setup";
  const deviceName = invalid ? name : `${name} Setup`;
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: `OpenClaw Matrix QA CLI ${name} Owner`,
    scenarioId,
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({ account, context, scenarioId });
  let cli: Awaited<ReturnType<typeof createMatrixQaCliE2eeSetupRuntime>> | undefined;
  let cliDeviceId: string | undefined;
  try {
    const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
      client: owner,
      label: invalid ? "cli invalid recovery-key owner" : "driver",
    });
    const encodedRecoveryKey = ready.recoveryKey?.encodedPrivateKey?.trim();
    if (!encodedRecoveryKey) {
      throw new Error(
        invalid
          ? "Matrix E2EE CLI invalid recovery-key setup did not seed secret storage"
          : "Matrix E2EE CLI recovery-key setup did not expose a recovery key",
      );
    }
    const cliDevice = await loginMatrixQaCliDevice(
      context.baseUrl,
      account,
      `OpenClaw Matrix QA CLI ${deviceName} Device`,
      `Matrix E2EE CLI ${label}`,
    );
    cliDeviceId = cliDevice.deviceId;
    cli = await createMatrixQaCliE2eeSetupRuntime({
      artifactLabel: invalid ? "cli-recovery-key-invalid" : "cli-recovery-key-setup",
      context,
      initialConfig: buildMatrixQaCliE2eeAccountConfig({
        accountId,
        accessToken: cliDevice.accessToken,
        baseUrl: context.baseUrl,
        deviceId: cliDevice.deviceId,
        encryption: false,
        name: `Matrix QA CLI ${deviceName}`,
        password: account.password,
        userId: cliDevice.userId,
      }),
    });
    if (!invalid) {
      const { artifacts: setupArtifacts, payload: setupPayload } = await runMatrixQaSetupCliJson(
        cli,
        "recovery-key-setup",
        ["matrix", "encryption", "setup", "--account", accountId, "--recovery-key-stdin", "--json"],
        context.timeoutMs,
        `${encodedRecoveryKey}\n`,
      );
      const setup = setupPayload as MatrixQaCliEncryptionSetupStatus;
      assertMatrixQaCliEncryptionSetupResult(
        setup,
        accountId,
        true,
        "Matrix CLI recovery-key encryption setup did not succeed",
      );
      assertMatrixQaCliE2eeStatus("Matrix CLI recovery-key encryption setup", setup.status, {
        allowUntrustedMatchingKey: true,
      });

      return {
        artifacts: {
          accountId,
          backupVersion: setup.status.backupVersion ?? ready.verification.backupVersion ?? null,
          cliDeviceId: setup.status.deviceId ?? cliDevice.deviceId,
          encryptionChanged: setup.encryptionChanged,
          recoveryKeyId: ready.recoveryKey?.keyId ?? null,
          recoveryKeyStored: true,
          setupSuccess: setup.success,
          verificationBootstrapSuccess: setup.bootstrap.success,
        },
        details: [
          "Matrix CLI encryption setup accepted a recovery key on a second device",
          `recovery setup stdout: ${setupArtifacts.stdoutPath}`,
          `recovery setup stderr: ${setupArtifacts.stderrPath}`,
          `owner backup version: ${ready.verification.backupVersion ?? "<none>"}`,
          `recovery key id: ${ready.recoveryKey?.keyId ?? "<none>"}`,
          `cli device: ${setup.status.deviceId ?? cliDevice.deviceId}`,
          `cli verified by owner: ${setup.status.verified ? "yes" : "no"}`,
          `cli backup usable: ${
            isMatrixQaCliBackupUsable(setup.status.backup, { allowUntrustedMatchingKey: true })
              ? "yes"
              : "no"
          }`,
        ].join("\n"),
      };
    }
    const invalidRecoveryKey = "not-a-valid-matrix-recovery-key";
    const failed = await runMatrixQaCliExpectedFailure({
      args: [
        "matrix",
        "encryption",
        "setup",
        "--account",
        accountId,
        "--recovery-key-stdin",
        "--json",
      ],
      start: cli.start,
      stdin: `${invalidRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "recovery-key-invalid",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus & {
      error?: string;
    };
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI invalid recovery-key setup did not report failure");
    }
    const failure = payload.bootstrap?.error ?? payload.error ?? "";
    if (!/recovery|secret|key/i.test(failure)) {
      throw new Error(
        `Matrix CLI invalid recovery-key setup failed for an unexpected reason: ${failure}`,
      );
    }
    if (failed.stdout.includes(invalidRecoveryKey) || failed.stderr.includes(invalidRecoveryKey)) {
      throw new Error("Matrix CLI invalid recovery-key output leaked the recovery key");
    }

    return {
      artifacts: {
        accountId,
        bootstrapErrorPreview: truncateUtf16Safe(failure, 240),
        bootstrapSuccess: false,
        cliDeviceId: cliDevice.deviceId,
        encryptionChanged: payload.encryptionChanged,
        recoveryKeyAccepted: false,
        recoveryKeyRejected: true,
        setupSuccess: false,
      },
      details: [
        "Matrix CLI encryption setup rejected an invalid recovery key without leaking it",
        `failure stdout: ${artifacts.stdoutPath}`,
        `failure stderr: ${artifacts.stderrPath}`,
        `cli device: ${cliDevice.deviceId}`,
        `failure: ${failure}`,
      ].join("\n"),
    };
  } finally {
    try {
      await owner.stop().catch(() => undefined);
      if (cliDeviceId) {
        await owner.deleteOwnDevices([cliDeviceId]).catch(() => undefined);
      }
    } finally {
      await cli?.dispose();
    }
  }
}
