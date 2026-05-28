import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_LOCK_BACKEND_ID,
  isExternalSessionLockBackendId,
  resolveSessionLockBackendId,
  evaluateSessionLockBackendPromotionGate,
  type SessionLockBackend,
  type SessionLockLease,
} from "./session-lock-backend.js";

describe("session-lock-backend contract", () => {
  it("defaults the session lock backend to file", () => {
    expect(resolveSessionLockBackendId()).toBe(DEFAULT_SESSION_LOCK_BACKEND_ID);
    expect(resolveSessionLockBackendId({})).toBe(DEFAULT_SESSION_LOCK_BACKEND_ID);
    expect(
      resolveSessionLockBackendId({
        session: { writeLock: { backend: "unknown-backend" } },
      }),
    ).toBe(DEFAULT_SESSION_LOCK_BACKEND_ID);
  });

  it.each(["file", "redis", "etcd", "postgres-advisory"] as const)(
    "accepts supported backend id %s",
    (backend) => {
      expect(resolveSessionLockBackendId({ session: { writeLock: { backend } } })).toBe(backend);
    },
  );

  it("distinguishes optional external backends from the default file backend", () => {
    expect(isExternalSessionLockBackendId("file")).toBe(false);
    expect(isExternalSessionLockBackendId("redis")).toBe(true);
    expect(isExternalSessionLockBackendId("etcd")).toBe(true);
    expect(isExternalSessionLockBackendId("postgres-advisory")).toBe(true);
  });

  it("keeps acquire, extend, release, fencing token, owner, expiry, and health in contract", async () => {
    const released: string[] = [];
    const createLease = (generation: number): SessionLockLease => ({
      backend: "file",
      resourceId: "session:main",
      ownerId: "owner-1",
      fencingToken: generation,
      acquiredAtMs: 1_000,
      expiresAtMs: 2_000 + generation,
      extend: async ({ ttlMs }) => ({
        ...createLease(generation + 1),
        expiresAtMs: 1_000 + ttlMs,
      }),
      release: async () => {
        released.push(`generation:${generation}`);
      },
    });
    const backend: SessionLockBackend = {
      id: "file",
      acquire: async () => createLease(1),
      backendHealth: () => ({
        readiness: "ready",
        liveness: "alive",
        checkedAtMs: 1_234,
      }),
    };

    const lease = await backend.acquire({
      resourceId: "session:main",
      ownerId: "owner-1",
      timeoutMs: 500,
      ttlMs: 1_000,
    });
    const extended = await lease.extend({ ttlMs: 3_000 });
    await lease.release();

    expect(lease).toMatchObject({
      backend: "file",
      resourceId: "session:main",
      ownerId: "owner-1",
      fencingToken: 1,
      expiresAtMs: 2_001,
    });
    expect(extended).toMatchObject({
      fencingToken: 2,
      expiresAtMs: 4_000,
    });
    expect(await backend.backendHealth()).toEqual({
      readiness: "ready",
      liveness: "alive",
      checkedAtMs: 1_234,
    });
    expect(released).toEqual(["generation:1"]);
  });

  it("blocks external backend promotion outside isolated canary scope", () => {
    expect(
      evaluateSessionLockBackendPromotionGate({
        requestedBackend: "redis",
        sessionScope: "production",
        canaryPassed: true,
        sameCaseRerunPassed: true,
        evidenceLocked: true,
        rollbackVerified: true,
      }),
    ).toEqual({
      allowed: false,
      activeBackend: "file",
      action: "block",
      reason: "external-backend-requires-isolated-canary",
    });
  });

  it("rolls external backend promotion back to file when canary fails", () => {
    expect(
      evaluateSessionLockBackendPromotionGate({
        requestedBackend: "etcd",
        sessionScope: "isolated",
        canaryPassed: false,
        sameCaseRerunPassed: false,
        evidenceLocked: false,
        rollbackVerified: true,
      }),
    ).toEqual({
      allowed: false,
      activeBackend: "file",
      action: "rollback",
      reason: "canary-failed",
    });
  });

  it("requires same-case rerun, evidence lock, rollback verification, and P0/P1 clear", () => {
    expect(
      evaluateSessionLockBackendPromotionGate({
        requestedBackend: "postgres-advisory",
        sessionScope: "isolated",
        canaryPassed: true,
        sameCaseRerunPassed: true,
        evidenceLocked: true,
        rollbackVerified: true,
        p0Count: 0,
        p1Count: 0,
      }),
    ).toEqual({
      allowed: true,
      activeBackend: "postgres-advisory",
      action: "promote",
      reason: "isolated-canary-passed",
    });
    expect(
      evaluateSessionLockBackendPromotionGate({
        requestedBackend: "postgres-advisory",
        sessionScope: "isolated",
        canaryPassed: true,
        sameCaseRerunPassed: true,
        evidenceLocked: true,
        rollbackVerified: true,
        p0Count: 1,
      }).reason,
    ).toBe("p0-p1-not-clear");
  });
});
