export const DEFAULT_SESSION_LOCK_BACKEND_ID = "file";

export type SessionLockBackendId = "file" | "redis" | "etcd" | "postgres-advisory";

export type SessionLockBackendConfig = {
  session?: {
    writeLock?: {
      backend?: unknown;
    };
  };
};

export type SessionLockBackendHealth = Readonly<{
  readiness: "ready" | "degraded" | "unavailable";
  liveness: "alive" | "degraded" | "dead";
  reason?: string;
  checkedAtMs?: number;
}>;

export type SessionLockAcquireParams = Readonly<{
  resourceId: string;
  ownerId: string;
  timeoutMs: number;
  ttlMs: number;
  allowReentrant?: boolean;
}>;

export type SessionLockExtendParams = Readonly<{
  ttlMs: number;
}>;

export type SessionLockLease = Readonly<{
  backend: SessionLockBackendId;
  resourceId: string;
  ownerId: string;
  fencingToken: number | string;
  acquiredAtMs: number;
  expiresAtMs: number;
  extend: (params: SessionLockExtendParams) => Promise<SessionLockLease>;
  release: () => Promise<void>;
}>;

export type SessionLockBackend = Readonly<{
  id: SessionLockBackendId;
  acquire: (params: SessionLockAcquireParams) => Promise<SessionLockLease>;
  backendHealth: () => Promise<SessionLockBackendHealth> | SessionLockBackendHealth;
}>;

export type SessionLockBackendPromotionGateInput = Readonly<{
  requestedBackend: SessionLockBackendId;
  currentBackend?: SessionLockBackendId;
  sessionScope: "isolated" | "shared" | "production";
  canaryPassed: boolean;
  sameCaseRerunPassed: boolean;
  evidenceLocked: boolean;
  rollbackVerified: boolean;
  p0Count?: number;
  p1Count?: number;
}>;

export type SessionLockBackendPromotionGateResult = Readonly<{
  allowed: boolean;
  activeBackend: SessionLockBackendId;
  action: "promote" | "rollback" | "block";
  reason: string;
}>;

const SESSION_LOCK_BACKEND_IDS = new Set<SessionLockBackendId>([
  "file",
  "redis",
  "etcd",
  "postgres-advisory",
]);

export function isSessionLockBackendId(value: unknown): value is SessionLockBackendId {
  return typeof value === "string" && SESSION_LOCK_BACKEND_IDS.has(value as SessionLockBackendId);
}

export function isExternalSessionLockBackendId(
  value: SessionLockBackendId,
): value is Exclude<SessionLockBackendId, typeof DEFAULT_SESSION_LOCK_BACKEND_ID> {
  return value !== DEFAULT_SESSION_LOCK_BACKEND_ID;
}

export function resolveSessionLockBackendId(
  config?: SessionLockBackendConfig,
): SessionLockBackendId {
  const backend = config?.session?.writeLock?.backend;
  return isSessionLockBackendId(backend) ? backend : DEFAULT_SESSION_LOCK_BACKEND_ID;
}

export function evaluateSessionLockBackendPromotionGate(
  input: SessionLockBackendPromotionGateInput,
): SessionLockBackendPromotionGateResult {
  const currentBackend = input.currentBackend ?? DEFAULT_SESSION_LOCK_BACKEND_ID;
  const p0Count = input.p0Count ?? 0;
  const p1Count = input.p1Count ?? 0;

  if (!isExternalSessionLockBackendId(input.requestedBackend)) {
    return {
      allowed: true,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "promote",
      reason: "file-backend-default",
    };
  }

  if (input.sessionScope !== "isolated") {
    return {
      allowed: false,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "block",
      reason: "external-backend-requires-isolated-canary",
    };
  }

  if (p0Count > 0 || p1Count > 0) {
    return {
      allowed: false,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "block",
      reason: "p0-p1-not-clear",
    };
  }

  if (!input.canaryPassed) {
    return {
      allowed: false,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "rollback",
      reason: "canary-failed",
    };
  }

  if (!input.sameCaseRerunPassed) {
    return {
      allowed: false,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "rollback",
      reason: "same-case-rerun-missing",
    };
  }

  if (!input.evidenceLocked) {
    return {
      allowed: false,
      activeBackend: DEFAULT_SESSION_LOCK_BACKEND_ID,
      action: "block",
      reason: "evidence-lock-missing",
    };
  }

  if (!input.rollbackVerified) {
    return {
      allowed: false,
      activeBackend: currentBackend,
      action: "block",
      reason: "rollback-verification-missing",
    };
  }

  return {
    allowed: true,
    activeBackend: input.requestedBackend,
    action: "promote",
    reason: "isolated-canary-passed",
  };
}
