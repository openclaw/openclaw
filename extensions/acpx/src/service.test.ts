import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acp-runtime";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime, OpenClawPluginServiceContext } from "../runtime-api.js";
import { ACPX_BUNDLED_BIN, ACPX_PINNED_VERSION } from "./config.js";
import { createAcpxRuntimeService } from "./service.js";

const { ensureAcpxSpy } = vi.hoisted(() => ({
  ensureAcpxSpy: vi.fn(async () => {}),
}));

vi.mock("./ensure.js", () => ({
  ensureAcpx: ensureAcpxSpy,
}));

type RuntimeStub = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};

function createRuntimeStub(healthy: boolean): {
  runtime: RuntimeStub;
  probeAvailabilitySpy: ReturnType<typeof vi.fn>;
  isHealthySpy: ReturnType<typeof vi.fn>;
} {
  const probeAvailabilitySpy = vi.fn(async () => {});
  const isHealthySpy = vi.fn(() => healthy);
  return {
    runtime: {
      ensureSession: vi.fn(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      })),
      runTurn: vi.fn(async function* () {
        yield { type: "done" as const };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      async probeAvailability() {
        await probeAvailabilitySpy();
      },
      isHealthy() {
        return isHealthySpy();
      },
    },
    probeAvailabilitySpy,
    isHealthySpy,
  };
}

function createRetryingRuntimeStub(
  healthSequence: boolean[],
  doctorReport: { ok: boolean; message: string; details?: string[] } = {
    ok: false,
    message: "acpx help check failed",
    details: ["stderr=temporary startup race"],
  },
): {
  runtime: RuntimeStub;
  probeAvailabilitySpy: ReturnType<typeof vi.fn>;
  isHealthySpy: ReturnType<typeof vi.fn>;
  doctorSpy: ReturnType<typeof vi.fn>;
} {
  let probeCount = 0;
  const probeAvailabilitySpy = vi.fn(async () => {
    probeCount += 1;
  });
  const isHealthySpy = vi.fn(() => {
    const index = Math.max(0, probeCount - 1);
    return healthSequence[Math.min(index, healthSequence.length - 1)] ?? false;
  });
  const doctorSpy = vi.fn(async () => doctorReport);
  return {
    runtime: {
      ensureSession: vi.fn(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      })),
      runTurn: vi.fn(async function* () {
        yield { type: "done" as const };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      async probeAvailability() {
        await probeAvailabilitySpy();
      },
      isHealthy() {
        return isHealthySpy();
      },
      async doctor() {
        return await doctorSpy();
      },
    },
    probeAvailabilitySpy,
    isHealthySpy,
    doctorSpy,
  };
}

function createServiceContext(
  overrides: Partial<OpenClawPluginServiceContext> = {},
): OpenClawPluginServiceContext {
  return {
    config: {},
    workspaceDir: "/tmp/workspace",
    stateDir: "/tmp/state",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

describe("createAcpxRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
    ensureAcpxSpy.mockReset();
    ensureAcpxSpy.mockImplementation(async () => {});
  });

  it("registers and unregisters the acpx backend", async () => {
    const { runtime, probeAvailabilitySpy } = createRuntimeStub(true);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await vi.waitFor(() => {
      expect(ensureAcpxSpy).toHaveBeenCalledOnce();
      expect(ensureAcpxSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stripProviderAuthEnvVars: true,
        }),
      );
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
    });

    await service.stop?.(context);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("marks backend unavailable when runtime health check fails", async () => {
    const { runtime } = createRuntimeStub(false);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      healthProbeRetryDelaysMs: [],
    });
    const context = createServiceContext();

    await service.start(context);

    expect(() => requireAcpRuntimeBackend("acpx")).toThrowError(AcpRuntimeError);
    try {
      requireAcpRuntimeBackend("acpx");
      throw new Error("expected ACP backend lookup to fail");
    } catch (error) {
      expect((error as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });

  it("passes queue-owner TTL from plugin config", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = vi.fn(() => runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        queueOwnerTtlSeconds: 0.25,
      },
    });
    const context = createServiceContext();

    await service.start(context);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        queueOwnerTtlSeconds: 0.25,
        pluginConfig: expect.objectContaining({
          command: ACPX_BUNDLED_BIN,
          expectedVersion: ACPX_PINNED_VERSION,
          allowPluginLocalInstall: true,
        }),
      }),
    );
  });

  it("uses a short default queue-owner TTL", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = vi.fn(() => runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });
    const context = createServiceContext();

    await service.start(context);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        queueOwnerTtlSeconds: 0.1,
      }),
    );
  });

  it("does not block startup while acpx ensure runs", async () => {
    const { runtime } = createRuntimeStub(true);
    ensureAcpxSpy.mockImplementation(() => new Promise<void>(() => {}));
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    const startResult = await Promise.race([
      Promise.resolve(service.start(context)).then(() => "started"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);

    expect(startResult).toBe("started");
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
  });

  it("creates the workspace dir before probing acpx", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-service-workspace-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const { runtime, probeAvailabilitySpy } = createRuntimeStub(true);
    const service = createAcpxRuntimeService({
      runtimeFactory: ({ pluginConfig }) => {
        expect(pluginConfig.cwd).toBe(workspaceDir);
        return runtime;
      },
    });
    const context = createServiceContext({ workspaceDir });

    try {
      await service.start(context);

      expect(fs.existsSync(workspaceDir)).toBe(true);
      await vi.waitFor(() => {
        expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
      });
    } finally {
      await service.stop?.(context);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries health probes until the runtime becomes healthy", async () => {
    const { runtime, probeAvailabilitySpy, doctorSpy } = createRetryingRuntimeStub([
      false,
      false,
      true,
    ]);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      healthProbeRetryDelaysMs: [0, 0],
    });
    const context = createServiceContext();

    await service.start(context);

    await vi.waitFor(() => {
      expect(probeAvailabilitySpy).toHaveBeenCalledTimes(3);
    });
    expect(doctorSpy).toHaveBeenCalledTimes(2);
    expect(context.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("probe attempt 1 failed"),
    );
    expect(context.logger.info).toHaveBeenCalledWith(
      "acpx runtime backend ready after 3 probe attempts",
    );
  });

  it("does not treat doctor ok as healthy when the runtime still reports unhealthy", async () => {
    const { runtime, probeAvailabilitySpy, doctorSpy } = createRetryingRuntimeStub([false], {
      ok: true,
      message: "acpx help check passed",
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
      healthProbeRetryDelaysMs: [],
    });
    const context = createServiceContext();

    await service.start(context);

    await vi.waitFor(() => {
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
      expect(doctorSpy).toHaveBeenCalledOnce();
      expect(context.logger.warn).toHaveBeenCalledWith(
        "acpx runtime backend probe failed: acpx help check passed",
      );
    });
    expect(context.logger.info).not.toHaveBeenCalledWith("acpx runtime backend ready");
    expect(() => requireAcpRuntimeBackend("acpx")).toThrowError(AcpRuntimeError);
  });
});
