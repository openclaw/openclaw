import { setTimeout as sleep } from "node:timers/promises";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../../types.js";
import { formatMatrixEncryptionUnavailableError } from "../encryption-guidance.js";
import type { MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import type { MatrixVerificationSummary } from "../sdk/verification-manager.js";
import { withResolvedActionClient, withStartedActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

const DEFAULT_MATRIX_SELF_VERIFICATION_TIMEOUT_MS = 180_000;

type MatrixCryptoActionFacade = NonNullable<import("../sdk.js").MatrixClient["crypto"]>;
type MatrixActionClient = import("../sdk.js").MatrixClient;

export type MatrixSelfVerificationResult = MatrixVerificationSummary & {
  deviceOwnerVerified: boolean;
  ownerVerification: MatrixOwnDeviceVerificationStatus;
};

function requireCrypto(
  client: import("../sdk.js").MatrixClient,
  opts: MatrixActionClientOpts,
): NonNullable<import("../sdk.js").MatrixClient["crypto"]> {
  if (!client.crypto) {
    if (!opts.cfg) {
      throw new Error(
        "Matrix verification actions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
      );
    }
    const cfg = requireRuntimeConfig(opts.cfg, "Matrix verification actions") as CoreConfig;
    throw new Error(formatMatrixEncryptionUnavailableError(cfg, opts.accountId));
  }
  return client.crypto;
}

function resolveVerificationId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Matrix verification request id is required");
  }
  return normalized;
}

function isSameMatrixVerification(
  left: MatrixVerificationSummary,
  right: MatrixVerificationSummary,
): boolean {
  return (
    left.id === right.id ||
    Boolean(left.transactionId && left.transactionId === right.transactionId)
  );
}

function isMatrixVerificationReadyForSas(summary: MatrixVerificationSummary): boolean {
  return (
    summary.completed ||
    summary.hasSas ||
    summary.phaseName === "ready" ||
    summary.phaseName === "started"
  );
}

function shouldStartMatrixSasVerification(summary: MatrixVerificationSummary): boolean {
  return !summary.hasSas && summary.phaseName !== "started" && !summary.completed;
}

function isMatrixVerificationCancelled(summary: MatrixVerificationSummary): boolean {
  return summary.phaseName === "cancelled";
}

async function waitForMatrixVerificationSummary(params: {
  crypto: MatrixCryptoActionFacade;
  label: string;
  request: MatrixVerificationSummary;
  timeoutMs: number;
  predicate: (summary: MatrixVerificationSummary) => boolean;
}): Promise<MatrixVerificationSummary> {
  const startedAt = Date.now();
  let last: MatrixVerificationSummary | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    const summaries = await params.crypto.listVerifications();
    const found = summaries.find((summary) => isSameMatrixVerification(summary, params.request));
    if (found) {
      last = found;
      if (params.predicate(found)) {
        return found;
      }
      if (isMatrixVerificationCancelled(found)) {
        throw new Error(
          `Matrix self-verification was cancelled${
            found.error ? `: ${found.error}` : ` while waiting to ${params.label}`
          }`,
        );
      }
    }
    await sleep(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(
    `Timed out waiting for Matrix self-verification to ${params.label}${
      last ? ` (last phase: ${last.phaseName})` : ""
    }`,
  );
}

function formatMatrixOwnerVerificationDiagnostics(
  status: MatrixOwnDeviceVerificationStatus | undefined,
): string {
  if (!status) {
    return "Matrix identity trust status was unavailable";
  }
  return `cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}, signed by owner: ${
    status.signedByOwner ? "yes" : "no"
  }, locally trusted: ${status.localVerified ? "yes" : "no"}`;
}

async function waitForMatrixOwnerVerificationStatus(params: {
  client: MatrixActionClient;
  timeoutMs: number;
}): Promise<MatrixOwnDeviceVerificationStatus> {
  const startedAt = Date.now();
  let last: MatrixOwnDeviceVerificationStatus | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    last = await params.client.getOwnDeviceVerificationStatus();
    if (last.verified) {
      return last;
    }
    await sleep(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(
    `Timed out waiting for Matrix self-verification to establish full Matrix identity trust for this device (${formatMatrixOwnerVerificationDiagnostics(
      last,
    )}). Complete self-verification from another Matrix client, then check Matrix verification status for details.`,
  );
}

async function cancelMatrixSelfVerificationOnFailure(params: {
  crypto: MatrixCryptoActionFacade;
  request: MatrixVerificationSummary | undefined;
}): Promise<void> {
  if (!params.request || typeof params.crypto.cancelVerification !== "function") {
    return;
  }
  await params.crypto
    .cancelVerification(params.request.id, {
      reason: "OpenClaw self-verification did not complete",
      code: "m.user",
    })
    .catch(() => undefined);
}

async function completeMatrixSelfVerification(params: {
  client: MatrixActionClient;
  completed: MatrixVerificationSummary;
  timeoutMs: number;
}): Promise<MatrixSelfVerificationResult> {
  const bootstrap = await params.client.bootstrapOwnDeviceVerification({
    allowAutomaticCrossSigningReset: false,
    verifyOwnIdentity: true,
  });
  if (!bootstrap.verification.verified) {
    throw new Error(
      `Matrix self-verification completed, but full Matrix identity trust is still incomplete: ${
        bootstrap.error ?? formatMatrixOwnerVerificationDiagnostics(bootstrap.verification)
      }`,
    );
  }
  const ownerVerification = await waitForMatrixOwnerVerificationStatus({
    client: params.client,
    timeoutMs: params.timeoutMs,
  });
  return {
    ...params.completed,
    deviceOwnerVerified: ownerVerification.verified,
    ownerVerification,
  };
}

export async function listMatrixVerifications(opts: MatrixActionClientOpts = {}) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.listVerifications();
  });
}

export async function requestMatrixVerification(
  params: MatrixActionClientOpts & {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  } = {},
) {
  return await withStartedActionClient(params, async (client) => {
    const crypto = requireCrypto(client, params);
    const ownUser = params.ownUser ?? (!params.userId && !params.deviceId && !params.roomId);
    return await crypto.requestVerification({
      ownUser,
      userId: normalizeOptionalString(params.userId),
      deviceId: normalizeOptionalString(params.deviceId),
      roomId: normalizeOptionalString(params.roomId),
    });
  });
}

export async function runMatrixSelfVerification(
  params: MatrixActionClientOpts & {
    confirmSas: (
      sas: NonNullable<MatrixVerificationSummary["sas"]>,
      summary: MatrixVerificationSummary,
    ) => Promise<boolean>;
    onReady?: (summary: MatrixVerificationSummary) => void | Promise<void>;
    onRequested?: (summary: MatrixVerificationSummary) => void | Promise<void>;
    onSas?: (summary: MatrixVerificationSummary) => void | Promise<void>;
    timeoutMs?: number;
  },
): Promise<MatrixSelfVerificationResult> {
  return await withStartedActionClient(params, async (client) => {
    const crypto = requireCrypto(client, params);
    const timeoutMs = params.timeoutMs ?? DEFAULT_MATRIX_SELF_VERIFICATION_TIMEOUT_MS;
    let requested: MatrixVerificationSummary | undefined;
    let requestCompleted = false;
    let handledByMismatch = false;
    try {
      requested = await crypto.requestVerification({ ownUser: true });
      await params.onRequested?.(requested);

      const ready = isMatrixVerificationReadyForSas(requested)
        ? requested
        : await waitForMatrixVerificationSummary({
            crypto,
            label: "be accepted in another Matrix client",
            request: requested,
            timeoutMs,
            predicate: isMatrixVerificationReadyForSas,
          });
      await params.onReady?.(ready);

      if (ready.completed) {
        requestCompleted = true;
        return await completeMatrixSelfVerification({ client, completed: ready, timeoutMs });
      }

      const started = shouldStartMatrixSasVerification(ready)
        ? await crypto.startVerification(ready.id, "sas")
        : ready;
      let sasSummary = started;
      if (!sasSummary.hasSas) {
        sasSummary = await waitForMatrixVerificationSummary({
          crypto,
          label: "show SAS emoji or decimals",
          request: started,
          timeoutMs,
          predicate: (summary) => summary.hasSas,
        });
      }
      if (!sasSummary.sas) {
        throw new Error("Matrix SAS data is not available for this verification request");
      }
      await params.onSas?.(sasSummary);

      const matched = await params.confirmSas(sasSummary.sas, sasSummary);
      if (!matched) {
        await crypto.mismatchVerificationSas(sasSummary.id);
        handledByMismatch = true;
        throw new Error("Matrix SAS verification was not confirmed.");
      }

      const confirmed = await crypto.confirmVerificationSas(sasSummary.id);
      const completed = confirmed.completed
        ? confirmed
        : await waitForMatrixVerificationSummary({
            crypto,
            label: "complete",
            request: confirmed,
            timeoutMs,
            predicate: (summary) => summary.completed,
          });
      requestCompleted = true;
      return await completeMatrixSelfVerification({ client, completed, timeoutMs });
    } catch (error) {
      if (!requestCompleted && !handledByMismatch) {
        await cancelMatrixSelfVerificationOnFailure({ crypto, request: requested });
      }
      throw error;
    }
  });
}

export async function acceptMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.acceptVerification(resolveVerificationId(requestId));
  });
}

export async function cancelMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { reason?: string; code?: string } = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.cancelVerification(resolveVerificationId(requestId), {
      reason: normalizeOptionalString(opts.reason),
      code: normalizeOptionalString(opts.code),
    });
  });
}

export async function startMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { method?: "sas" } = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.startVerification(resolveVerificationId(requestId), opts.method ?? "sas");
  });
}

export async function generateMatrixVerificationQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.generateVerificationQr(resolveVerificationId(requestId));
  });
}

export async function scanMatrixVerificationQr(
  requestId: string,
  qrDataBase64: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    const payload = qrDataBase64.trim();
    if (!payload) {
      throw new Error("Matrix QR data is required");
    }
    return await crypto.scanVerificationQr(resolveVerificationId(requestId), payload);
  });
}

export async function getMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.getVerificationSas(resolveVerificationId(requestId));
  });
}

export async function confirmMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.confirmVerificationSas(resolveVerificationId(requestId));
  });
}

export async function mismatchMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.mismatchVerificationSas(resolveVerificationId(requestId));
  });
}

export async function confirmMatrixVerificationReciprocateQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.confirmVerificationReciprocateQr(resolveVerificationId(requestId));
  });
}

export async function getMatrixEncryptionStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  return await withResolvedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    const recoveryKey = await crypto.getRecoveryKey();
    return {
      encryptionEnabled: true,
      recoveryKeyStored: Boolean(recoveryKey),
      recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
      ...(opts.includeRecoveryKey ? { recoveryKey: recoveryKey?.encodedPrivateKey ?? null } : {}),
      pendingVerifications: (await crypto.listVerifications()).length,
    };
  });
}

export async function getMatrixVerificationStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  return await withResolvedActionClient(opts, async (client) => {
    const status = await client.getOwnDeviceVerificationStatus();
    const payload = {
      ...status,
      pendingVerifications: client.crypto ? (await client.crypto.listVerifications()).length : 0,
    };
    if (!opts.includeRecoveryKey) {
      return payload;
    }
    const recoveryKey = client.crypto ? await client.crypto.getRecoveryKey() : null;
    return {
      ...payload,
      recoveryKey: recoveryKey?.encodedPrivateKey ?? null,
    };
  });
}

export async function getMatrixRoomKeyBackupStatus(opts: MatrixActionClientOpts = {}) {
  return await withResolvedActionClient(
    opts,
    async (client) => await client.getRoomKeyBackupStatus(),
  );
}

export async function verifyMatrixRecoveryKey(
  recoveryKey: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) => await client.verifyWithRecoveryKey(recoveryKey),
  );
}

export async function restoreMatrixRoomKeyBackup(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
  } = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) =>
      await client.restoreRoomKeyBackup({
        recoveryKey: normalizeOptionalString(opts.recoveryKey),
      }),
  );
}

export async function resetMatrixRoomKeyBackup(opts: MatrixActionClientOpts = {}) {
  return await withStartedActionClient(opts, async (client) => await client.resetRoomKeyBackup());
}

export async function bootstrapMatrixVerification(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
  } = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) =>
      await client.bootstrapOwnDeviceVerification({
        recoveryKey: normalizeOptionalString(opts.recoveryKey),
        forceResetCrossSigning: opts.forceResetCrossSigning === true,
      }),
  );
}
