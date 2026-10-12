import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { startMatrixQaFaultProxy } from "../substrate/fault-proxy.js";
import {
  assertMatrixQaCliAccountAddBootstrapStatus,
  assertMatrixQaCliE2eeStatus,
  assertMatrixQaCliEncryptionSetupResult,
  buildMatrixQaCliE2eeAccountConfig,
  runMatrixQaCliExpectedFailure,
} from "./scenario-runtime-e2ee-cli-config.js";
import { createMatrixQaCliE2eeSetupRuntime } from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  isMatrixQaCliBackupUsable,
  parseMatrixQaCliJson,
  loginMatrixQaCliDevice,
  registerMatrixQaCliE2eeAccount,
  runMatrixQaSetupCliJson,
  type MatrixQaCliAccountAddStatus,
  type MatrixQaCliEncryptionSetupStatus,
  type MatrixQaCliVerificationStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import { buildRoomKeyBackupUnavailableFaultRule } from "./scenario-runtime-e2ee-room.js";
import { MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID } from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeCliAccountAddEnableE2eeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-add-e2ee";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Account Add Owner",
    scenarioId: "matrix-e2ee-cli-account-add-enable-e2ee",
  });
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-account-add-enable-e2ee",
    context,
  });
  try {
    const { artifacts: addArtifacts, payload: addedPayload } = await runMatrixQaSetupCliJson(
      cli,
      "account-add-enable-e2ee",
      [
        "matrix",
        "account",
        "add",
        "--account",
        accountId,
        "--name",
        "Matrix QA CLI Account Add E2EE",
        "--homeserver",
        context.baseUrl,
        "--user-id",
        account.userId,
        "--password",
        account.password,
        "--device-name",
        "OpenClaw Matrix QA CLI Account Add E2EE",
        "--allow-private-network",
        "--enable-e2ee",
        "--json",
      ],
    );
    const added = addedPayload as MatrixQaCliAccountAddStatus;
    if (added.accountId !== accountId || added.encryptionEnabled !== true) {
      throw new Error(
        "Matrix CLI account add did not report E2EE enabled for the expected account",
      );
    }
    if (added.verificationBootstrap?.attempted !== true) {
      throw new Error("Matrix CLI account add did not attempt verification bootstrap");
    }
    if (added.verificationBootstrap.success !== true) {
      throw new Error(
        `Matrix CLI account add verification bootstrap failed: ${added.verificationBootstrap.error ?? "unknown error"}`,
      );
    }

    const { artifacts: statusArtifacts, payload: statusPayload } = await runMatrixQaSetupCliJson(
      cli,
      "verify-status",
      [
        "matrix",
        "verify",
        "status",
        "--account",
        accountId,
        "--allow-degraded-local-state",
        "--json",
      ],
    );
    const status = statusPayload as MatrixQaCliVerificationStatus;
    assertMatrixQaCliAccountAddBootstrapStatus({
      expectedBackupVersion: added.verificationBootstrap.backupVersion,
      expectedUserId: account.userId,
      status,
    });
    const cliDeviceId = status.deviceId ?? null;

    return {
      artifacts: {
        accountId,
        backupVersion: added.verificationBootstrap.backupVersion ?? null,
        cliDeviceId,
        encryptionEnabled: added.encryptionEnabled,
        verificationBootstrapAttempted: added.verificationBootstrap.attempted,
        verificationBootstrapSuccess: added.verificationBootstrap.success,
      },
      details: [
        "Matrix CLI account add --enable-e2ee created an encrypted account and bootstrapped recovery state",
        `account add stdout: ${addArtifacts.stdoutPath}`,
        `account add stderr: ${addArtifacts.stderrPath}`,
        `verify status stdout: ${statusArtifacts.stdoutPath}`,
        `verify status stderr: ${statusArtifacts.stderrPath}`,
        `cli device: ${cliDeviceId ?? "<unknown>"}`,
        `cli verified by owner: ${status.verified ? "yes" : "no"}`,
        `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export function runMatrixQaE2eeCliEncryptionSetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return runMatrixQaCliEncryptionSetup(context, false);
}

export function runMatrixQaE2eeCliEncryptionSetupIdempotentScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return runMatrixQaCliEncryptionSetup(context, true);
}

async function runMatrixQaCliEncryptionSetup(
  context: MatrixQaScenarioContext,
  idempotent: boolean,
): Promise<MatrixQaScenarioExecution> {
  const accountId = idempotent ? "cli-encryption-idempotent" : "cli-encryption-setup";
  const artifactLabel = idempotent ? "cli-encryption-setup-idempotent" : "cli-encryption-setup";
  const deviceLabel = idempotent ? "Encryption Idempotent" : "Encryption Setup";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: `OpenClaw Matrix QA CLI ${deviceLabel} Owner`,
    scenarioId: idempotent
      ? "matrix-e2ee-cli-encryption-setup-idempotent"
      : "matrix-e2ee-cli-encryption-setup",
  });
  const cliDevice = await loginMatrixQaCliDevice(
    context.baseUrl,
    account,
    `OpenClaw Matrix QA CLI ${deviceLabel} Device`,
    idempotent ? "Matrix E2EE CLI idempotent setup" : "Matrix E2EE CLI encryption setup",
  );
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel,
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: idempotent,
      name: idempotent
        ? "Matrix QA CLI Encryption Setup Idempotent"
        : "Matrix QA CLI Encryption Setup",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    if (!idempotent) {
      const { artifacts: setupArtifacts, payload: setupPayload } = await runMatrixQaSetupCliJson(
        cli,
        "encryption-setup",
        ["matrix", "encryption", "setup", "--account", accountId, "--json"],
      );
      const setup = setupPayload as MatrixQaCliEncryptionSetupStatus;
      assertMatrixQaCliEncryptionSetupResult(
        setup,
        accountId,
        true,
        "Matrix CLI encryption setup did not report a successful E2EE upgrade",
      );
      assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup", setup.status);

      const { artifacts: statusArtifacts, payload: statusPayload } = await runMatrixQaSetupCliJson(
        cli,
        "verify-status",
        ["matrix", "verify", "status", "--account", accountId, "--json"],
      );
      const status = statusPayload as MatrixQaCliVerificationStatus;
      assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup status", status);

      return {
        artifacts: {
          accountId,
          cliDeviceId: status.deviceId ?? cliDevice.deviceId,
          encryptionChanged: setup.encryptionChanged,
          setupSuccess: setup.success,
          verificationBootstrapSuccess: setup.bootstrap.success,
        },
        details: [
          "Matrix CLI encryption setup upgraded an existing account and bootstrapped verification",
          `encryption setup stdout: ${setupArtifacts.stdoutPath}`,
          `encryption setup stderr: ${setupArtifacts.stderrPath}`,
          `verify status stdout: ${statusArtifacts.stdoutPath}`,
          `verify status stderr: ${statusArtifacts.stderrPath}`,
          `cli device: ${status.deviceId ?? cliDevice.deviceId}`,
          `cli verified by owner: ${status.verified ? "yes" : "no"}`,
          `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
        ].join("\n"),
      };
    }
    const runIdempotentSetup = async (ordinal: "first" | "second") => {
      const { artifacts, payload } = await runMatrixQaSetupCliJson(
        cli,
        `encryption-setup-${ordinal}`,
        ["matrix", "encryption", "setup", "--account", accountId, "--json"],
      );
      const setup = payload as MatrixQaCliEncryptionSetupStatus;
      assertMatrixQaCliEncryptionSetupResult(
        setup,
        accountId,
        false,
        `Matrix CLI encryption setup was not idempotent on ${ordinal} run`,
      );
      assertMatrixQaCliE2eeStatus(
        `Matrix CLI encryption setup idempotent ${ordinal} run`,
        setup.status,
      );
      return { artifacts, setup };
    };
    const { artifacts: firstArtifacts, setup: first } = await runIdempotentSetup("first");
    const { artifacts: secondArtifacts, setup: second } = await runIdempotentSetup("second");

    return {
      artifacts: {
        accountId,
        cliDeviceId: second.status.deviceId ?? cliDevice.deviceId,
        firstEncryptionChanged: first.encryptionChanged,
        secondEncryptionChanged: second.encryptionChanged,
        setupSuccess: second.success,
        verificationBootstrapSuccess: second.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup stayed idempotent on an already encrypted account",
        `first setup stdout: ${firstArtifacts.stdoutPath}`,
        `first setup stderr: ${firstArtifacts.stderrPath}`,
        `second setup stdout: ${secondArtifacts.stdoutPath}`,
        `second setup stderr: ${secondArtifacts.stderrPath}`,
        `cli device: ${second.status.deviceId ?? cliDevice.deviceId}`,
        `first encryption changed: ${first.encryptionChanged ? "yes" : "no"}`,
        `second encryption changed: ${second.encryptionChanged ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-failure";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Failure Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
  });
  const cliDevice = await loginMatrixQaCliDevice(
    context.baseUrl,
    account,
    "OpenClaw Matrix QA CLI Encryption Failure Device",
    "Matrix E2EE CLI bootstrap-failure",
  );
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.faultProxyTargetBaseUrl ?? context.baseUrl,
    ...context.faultProxyObserver,
    rules: [buildRoomKeyBackupUnavailableFaultRule(cliDevice.accessToken)],
  });
  let cli: Awaited<ReturnType<typeof createMatrixQaCliE2eeSetupRuntime>> | undefined;
  let outcome: PromiseSettledResult<MatrixQaScenarioExecution>;
  try {
    cli = await createMatrixQaCliE2eeSetupRuntime({
      artifactLabel: "cli-encryption-setup-bootstrap-failure",
      context,
      initialConfig: buildMatrixQaCliE2eeAccountConfig({
        accountId,
        accessToken: cliDevice.accessToken,
        baseUrl: proxy.baseUrl,
        deviceId: cliDevice.deviceId,
        encryption: false,
        name: "Matrix QA CLI Encryption Setup Bootstrap Failure",
        password: account.password,
        userId: cliDevice.userId,
      }),
    });
    const failed = await runMatrixQaCliExpectedFailure({
      args: ["matrix", "encryption", "setup", "--account", accountId, "--json"],
      start: cli.start,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-bootstrap-failure",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus;
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI encryption setup failure did not report unsuccessful bootstrap");
    }
    const faultHits = proxy.hits();
    if (!faultHits.some((hit) => hit.method === "POST")) {
      throw new Error(
        "Matrix CLI encryption setup did not attempt faulted room-key backup creation",
      );
    }
    const bootstrapError = payload.bootstrap?.error ?? "";
    if (!bootstrapError.toLowerCase().includes("room key backup")) {
      throw new Error(
        `Matrix CLI encryption setup failed for an unexpected reason: ${bootstrapError}`,
      );
    }

    outcome = {
      status: "fulfilled",
      value: {
        artifacts: {
          accountId,
          bootstrapErrorPreview: truncateUtf16Safe(bootstrapError, 240),
          bootstrapSuccess: false,
          cliDeviceId: cliDevice.deviceId,
          faultedEndpoint: faultHits[0]?.path,
          faultHitCount: faultHits.length,
          faultRuleId: MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
        },
        details: [
          "Matrix CLI encryption setup surfaced a bootstrap failure from a faulted room-key backup endpoint",
          `failure stdout: ${artifacts.stdoutPath}`,
          `failure stderr: ${artifacts.stderrPath}`,
          `fault hits: ${faultHits.length}`,
          `fault endpoint: ${faultHits[0]?.path ?? "<none>"}`,
          `bootstrap error: ${bootstrapError}`,
        ].join("\n"),
      },
    };
  } catch (reason) {
    outcome = { status: "rejected", reason };
  }
  // Join both async disposers before reporting the scenario or cleanup failures.
  const cleanup = await Promise.allSettled([cli?.dispose(), proxy.stop()]);
  const failures: unknown[] = outcome.status === "rejected" ? [outcome.reason] : [];
  failures.push(
    ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
  if (outcome.status === "fulfilled" && failures.length === 0) {
    return outcome.value;
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Matrix QA CLI bootstrap-failure lifecycle failed", {
        cause: failures[0],
      });
}
