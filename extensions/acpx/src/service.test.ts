import type { AcpRuntime, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../src/acp/runtime/registry.js";
import { ACPX_BUNDLED_BIN } from "./config.js";
import { createAcpxRuntimeService } from "./service.js";

const { ensurePinnedAcpxSpy } = vi.hoisted(() => ({
  ensurePinnedAcpxSpy: vi.fn(async () => {}),
}));

vi.mock("./ensure.js", () => ({
  ensurePinnedAcpx: ensurePinnedAcpxSpy,
}));

type RuntimeStub = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
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
    ensurePinnedAcpxSpy.mockReset();
    ensurePinnedAcpxSpy.mockImplementation(async () => {});
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
      expect(ensurePinnedAcpxSpy).toHaveBeenCalledOnce();
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
    });

    await service.stop?.(context);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("marks backend unavailable when runtime health check fails", async () => {
    const { runtime } = createRuntimeStub(false);
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime,
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
    ensurePinnedAcpxSpy.mockImplementation(() => new Promise<void>(() => {}));
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
});
