import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import { recordCurrentStorageMetaDeviceId, resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { assertMatrixSupportedStateFile } from "../retired-state.js";
import type { MatrixClient, MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";

const STARTUP_VERIFICATION_STATE_FILENAME = "startup-verification.json";
const STARTUP_VERIFICATION_NAMESPACE = "startup-verification";
const STARTUP_VERIFICATION_MAX_ENTRIES = 1_000;
const DEFAULT_STARTUP_VERIFICATION_MODE = "if-unverified" as const;
const DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS = 24;
const DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

type MatrixStartupVerificationState = {
  userId?: string | null;
  deviceId?: string | null;
  attemptedAt?: string;
  outcome?: "requested" | "failed";
  requestId?: string;
  transactionId?: string;
  error?: string;
};

export type MatrixStartupVerificationOutcome =
  | {
      kind: "disabled" | "verified" | "cooldown" | "pending" | "requested" | "request-failed";
      verification: MatrixOwnDeviceVerificationStatus;
      requestId?: string;
      transactionId?: string;
      error?: string;
      retryAfterMs?: number;
    }
  | {
      kind: "unsupported";
      verification?: undefined;
    };

function normalizeCooldownHours(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS;
  }
  return Math.max(0, value);
}

function createStartupVerificationStore(params: { env?: NodeJS.ProcessEnv; stateDir?: string }) {
  return getMatrixRuntime().state.openKeyedStoreV2<MatrixStartupVerificationState>({
    namespace: STARTUP_VERIFICATION_NAMESPACE,
    maxEntries: STARTUP_VERIFICATION_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv(params),
  });
}

function resolveStartupVerificationTimestamp(nowMs: unknown): string {
  return (
    timestampMsToIsoString(nowMs) ??
    timestampMsToIsoString(Date.now()) ??
    "1970-01-01T00:00:00.000Z"
  );
}

function resolveStartupVerificationRetryAfterMs(params: {
  state: MatrixStartupVerificationState | null;
  verification: MatrixOwnDeviceVerificationStatus;
  stateCooldownMs: number;
  nowMs: number;
}): number | undefined {
  if (!params.state || params.stateCooldownMs <= 0) {
    return undefined;
  }
  if (
    params.state.userId &&
    params.verification.userId &&
    params.state.userId !== params.verification.userId
  ) {
    return undefined;
  }
  if (
    params.state.deviceId &&
    params.verification.deviceId &&
    params.state.deviceId !== params.verification.deviceId
  ) {
    return undefined;
  }
  const attemptedAtMs = Date.parse(params.state.attemptedAt ?? "");
  if (!Number.isFinite(attemptedAtMs)) {
    return undefined;
  }
  const remaining = attemptedAtMs + params.stateCooldownMs - params.nowMs;
  return remaining > 0 ? remaining : undefined;
}

export async function ensureMatrixStartupVerification(params: {
  client: Pick<MatrixClient, "crypto" | "getOwnDeviceVerificationStatus">;
  auth: MatrixAuth;
  accountConfig: Pick<MatrixConfig, "startupVerification" | "startupVerificationCooldownHours">;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  stateDir?: string;
  stateFilePath?: string;
}): Promise<MatrixStartupVerificationOutcome> {
  if (params.auth.encryption !== true || !params.client.crypto) {
    return { kind: "unsupported" };
  }

  const verification = await params.client.getOwnDeviceVerificationStatus();
  let statePath = params.stateFilePath;
  if (statePath == null) {
    const storagePaths = await resolveMatrixStoragePaths({
      ...params.auth,
      env: params.env,
      stateDir: params.stateDir,
    });
    statePath = path.join(storagePaths.rootDir, STARTUP_VERIFICATION_STATE_FILENAME);
  }
  await assertMatrixSupportedStateFile(statePath);
  const stateLocation = {
    env: params.env,
    stateDir: params.stateDir ?? path.dirname(statePath),
  };
  const stateKey = params.auth.accountId.trim() || "default";
  const mode = params.accountConfig.startupVerification ?? DEFAULT_STARTUP_VERIFICATION_MODE;
  if (verification.verified || mode === "off") {
    await createStartupVerificationStore(stateLocation)
      .delete(stateKey)
      .catch(() => {});
    return {
      kind: verification.verified ? "verified" : "disabled",
      verification,
    };
  }

  const verifications = await params.client.crypto.listVerifications().catch(() => []);
  if (
    verifications.some((entry) => entry.isSelfVerification && !entry.completed && entry.pending)
  ) {
    return {
      kind: "pending",
      verification,
    };
  }

  const cooldownHours = normalizeCooldownHours(
    params.accountConfig.startupVerificationCooldownHours,
  );
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const nowMs = params.nowMs ?? Date.now();
  const attemptedAt = resolveStartupVerificationTimestamp(nowMs);
  const value = await createStartupVerificationStore(stateLocation).lookup(stateKey);
  const state = value && typeof value === "object" ? value : null;
  const stateCooldownMs =
    state?.outcome === "failed"
      ? Math.min(cooldownMs, DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS)
      : cooldownMs;
  const retryAfterMs = resolveStartupVerificationRetryAfterMs({
    state,
    verification,
    stateCooldownMs,
    nowMs,
  });
  if (retryAfterMs !== undefined) {
    return {
      kind: "cooldown",
      verification,
      retryAfterMs,
    };
  }

  const writeState = async (outcome: MatrixStartupVerificationState) => {
    await createStartupVerificationStore(stateLocation).register(stateKey, {
      userId: verification.userId,
      deviceId: verification.deviceId,
      attemptedAt,
      ...outcome,
    });
    if (typeof verification.deviceId === "string" && verification.deviceId.trim()) {
      await recordCurrentStorageMetaDeviceId({
        rootDir: path.dirname(statePath),
        deviceId: verification.deviceId,
      });
    }
  };
  try {
    const request = await params.client.crypto.requestVerification({ ownUser: true });
    await writeState({
      outcome: "requested",
      requestId: request.id,
      transactionId: request.transactionId,
    });
    return {
      kind: "requested",
      verification,
      requestId: request.id,
      transactionId: request.transactionId ?? undefined,
    };
  } catch (err) {
    const error = formatErrorMessage(err);
    await writeState({ outcome: "failed", error }).catch(() => {});
    return {
      kind: "request-failed",
      verification,
      error,
    };
  }
}
