import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "./errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "./registry.js";
import type { AcpRuntime } from "./types.js";

function createRuntimeStub(): AcpRuntime {
  return {
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "stub",
      runtimeSessionName: `${input.sessionKey}:runtime`,
    })),
    runTurn: vi.fn(async function* () {
      // no-op stream
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("acp runtime registry", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and resolves backends by id", () => {
    const runtime = createRuntimeStub();
    registerAcpRuntimeBackend({ id: "acpx-plugin", runtime });

    const backend = getAcpRuntimeBackend("acpx-plugin");
    expect(backend?.id).toBe("acpx-plugin");
    expect(backend?.runtime).toBe(runtime);
  });

  it("prefers a healthy backend when resolving without explicit id", () => {
    const unhealthyRuntime = createRuntimeStub();
    const healthyRuntime = createRuntimeStub();

    registerAcpRuntimeBackend({
      id: "unhealthy",
      runtime: unhealthyRuntime,
      healthy: () => false,
    });
    registerAcpRuntimeBackend({
      id: "healthy",
      runtime: healthyRuntime,
      healthy: () => true,
    });

    const backend = getAcpRuntimeBackend();
    expect(backend?.id).toBe("healthy");
  });

  it("throws a typed missing-backend error when no backend is registered", () => {
    expect(() => requireAcpRuntimeBackend()).toThrowError(AcpRuntimeError);
    expect(() => requireAcpRuntimeBackend()).toThrowError(/ACP runtime backend is not configured/i);
  });

  it("throws a typed unavailable error when the requested backend is unhealthy", () => {
    registerAcpRuntimeBackend({
      id: "acpx-plugin",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });

    try {
      requireAcpRuntimeBackend("acpx-plugin");
      throw new Error("expected requireAcpRuntimeBackend to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AcpRuntimeError);
      expect((err as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });

  it("unregisters a backend by id", () => {
    registerAcpRuntimeBackend({ id: "acpx-plugin", runtime: createRuntimeStub() });
    unregisterAcpRuntimeBackend("acpx-plugin");
    expect(getAcpRuntimeBackend("acpx-plugin")).toBeNull();
  });

  it("keeps backend state on a global registry for cross-loader access", () => {
    const runtime = createRuntimeStub();
    const sharedState = __testing.getAcpRuntimeRegistryGlobalStateForTests();

    sharedState.backendsById.set("acpx-plugin", {
      id: "acpx-plugin",
      runtime,
    });

    const backend = getAcpRuntimeBackend("acpx-plugin");
    expect(backend?.runtime).toBe(runtime);
  });
});
