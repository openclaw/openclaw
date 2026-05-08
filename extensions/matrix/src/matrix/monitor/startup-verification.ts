import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MatrixConfig } from "../../types.js";
import type { MatrixAuth } from "../client/types.js";
import { formatMatrixErrorMessage } from "../errors.js";
import type { MatrixClient, MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import { withMatrixSqliteStateEnvAsync } from "../sqlite-state.js";

const MATRIX_PLUGIN_ID = "matrix";
const STARTUP_VERIFICATION_NAMESPACE = "startup-verification";
const STARTUP_VERIFICATION_MAX_ENTRIES = 1_000;
const DEFAULT_STARTUP_VERIFICATION_MODE = "if-unverified" as const;
const DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS = 24;
const DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const startupVerificationStore = createPluginStateKeyedStore<MatrixStartupVerificationState>(
  MATRIX_PLUGIN_ID,
  {
    namespace: STARTUP_VERIFICATION_NAMESPACE,
    maxEntries: STARTUP_VERIFICATION_MAX_ENTRIES,
  },
);

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

function buildStartupVerificationKey(auth: MatrixAuth): string {
  return auth.accountId.trim() || "default";
}

async function readStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateFilePath?: string;
}): Promise<MatrixStartupVerificationState | null> {
  const value = await withMatrixSqliteStateEnvAsync(
    {
      env: params.env,
      storagePath: params.stateFilePath,
    },
    () => startupVerificationStore.lookup(buildStartupVerificationKey(params.auth)),
  );
  return value && typeof value === "object" ? value : null;
}

async function clearStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateFilePath?: string;
}): Promise<void> {
  await withMatrixSqliteStateEnvAsync(
    {
      env: params.env,
      storagePath: params.stateFilePath,
    },
    () => startupVerificationStore.delete(buildStartupVerificationKey(params.auth)),
  ).catch(() => {});
}

async function writeStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateFilePath?: string;
  state: MatrixStartupVerificationState;
}): Promise<void> {
  await withMatrixSqliteStateEnvAsync(
    {
      env: params.env,
      storagePath: params.stateFilePath,
    },
    () =>
      startupVerificationStore.register(
        buildStartupVerificationKey(params.auth),
        JSON.parse(JSON.stringify(params.state)) as MatrixStartupVerificationState,
      ),
  );
}

function resolveStateCooldownMs(
  state: MatrixStartupVerificationState | null,
  cooldownMs: number,
): number {
  if (state?.outcome === "failed") {
    return Math.min(cooldownMs, DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS);
  }
  return cooldownMs;
}

function resolveRetryAfterMs(params: {
  attemptedAt?: string;
  cooldownMs: number;
  nowMs: number;
}): number | undefined {
  const attemptedAtMs = Date.parse(params.attemptedAt ?? "");
  if (!Number.isFinite(attemptedAtMs)) {
    return undefined;
  }
  const remaining = attemptedAtMs + params.cooldownMs - params.nowMs;
  return remaining > 0 ? remaining : undefined;
}

function shouldHonorCooldown(params: {
  state: MatrixStartupVerificationState | null;
  verification: MatrixOwnDeviceVerificationStatus;
  stateCooldownMs: number;
  nowMs: number;
}): boolean {
  if (!params.state || params.stateCooldownMs <= 0) {
    return false;
  }
  if (
    params.state.userId &&
    params.verification.userId &&
    params.state.userId !== params.verification.userId
  ) {
    return false;
  }
  if (
    params.state.deviceId &&
    params.verification.deviceId &&
    params.state.deviceId !== params.verification.deviceId
  ) {
    return false;
  }
  return (
    resolveRetryAfterMs({
      attemptedAt: params.state.attemptedAt,
      cooldownMs: params.stateCooldownMs,
      nowMs: params.nowMs,
    }) !== undefined
  );
}

function hasPendingSelfVerification(
  verifications: Array<{
    isSelfVerification: boolean;
    completed: boolean;
    pending: boolean;
  }>,
): boolean {
  return verifications.some(
    (entry) => entry.isSelfVerification && !entry.completed && entry.pending,
  );
}

export async function ensureMatrixStartupVerification(params: {
  client: Pick<MatrixClient, "crypto" | "getOwnDeviceVerificationStatus">;
  auth: MatrixAuth;
  accountConfig: Pick<MatrixConfig, "startupVerification" | "startupVerificationCooldownHours">;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  stateFilePath?: string;
}): Promise<MatrixStartupVerificationOutcome> {
  if (params.auth.encryption !== true || !params.client.crypto) {
    return { kind: "unsupported" };
  }

  const verification = await params.client.getOwnDeviceVerificationStatus();
  if (verification.verified) {
    await clearStartupVerificationState(params);
    return {
      kind: "verified",
      verification,
    };
  }

  const mode = params.accountConfig.startupVerification ?? DEFAULT_STARTUP_VERIFICATION_MODE;
  if (mode === "off") {
    await clearStartupVerificationState(params);
    return {
      kind: "disabled",
      verification,
    };
  }

  const verifications = await params.client.crypto.listVerifications().catch(() => []);
  if (hasPendingSelfVerification(verifications)) {
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
  const state = await readStartupVerificationState(params);
  const stateCooldownMs = resolveStateCooldownMs(state, cooldownMs);
  if (shouldHonorCooldown({ state, verification, stateCooldownMs, nowMs })) {
    return {
      kind: "cooldown",
      verification,
      retryAfterMs: resolveRetryAfterMs({
        attemptedAt: state?.attemptedAt,
        cooldownMs: stateCooldownMs,
        nowMs,
      }),
    };
  }

  try {
    const request = await params.client.crypto.requestVerification({ ownUser: true });
    await writeStartupVerificationState({
      ...params,
      state: {
        userId: verification.userId,
        deviceId: verification.deviceId,
        attemptedAt: new Date(nowMs).toISOString(),
        outcome: "requested",
        requestId: request.id,
        transactionId: request.transactionId,
      },
    });
    return {
      kind: "requested",
      verification,
      requestId: request.id,
      transactionId: request.transactionId ?? undefined,
    };
  } catch (err) {
    const error = formatMatrixErrorMessage(err);
    await writeStartupVerificationState({
      ...params,
      state: {
        userId: verification.userId,
        deviceId: verification.deviceId,
        attemptedAt: new Date(nowMs).toISOString(),
        outcome: "failed",
        error,
      },
    }).catch(() => {});
    return {
      kind: "request-failed",
      verification,
      error,
    };
  }
}
