import type { AcpRuntime, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/acp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../src/acp/runtime/registry.js";
import { createAcpRemoteRuntimeService } from "./service.js";

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
        backend: "acp-remote",
        runtimeSessionName: input.sessionKey,
        backendSessionId: input.sessionKey,
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

describe("createAcpRemoteRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and unregisters the acp-remote backend", async () => {
    const { runtime, probeAvailabilitySpy } = createRuntimeStub(true);
    const service = createAcpRemoteRuntimeService({
      pluginConfig: {
        url: "http://127.0.0.1:8787/acp",
      },
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);
    expect(getAcpRuntimeBackend("acp-remote")?.runtime).toBe(runtime);

    await vi.waitFor(() => {
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
    });

    await service.stop?.(context);
    expect(getAcpRuntimeBackend("acp-remote")).toBeNull();
  });

  it("marks backend unavailable when runtime health check fails", async () => {
    const { runtime } = createRuntimeStub(false);
    const service = createAcpRemoteRuntimeService({
      pluginConfig: {
        url: "http://127.0.0.1:8787/acp",
      },
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);

    expect(() => requireAcpRuntimeBackend("acp-remote")).toThrowError(AcpRuntimeError);
    try {
      requireAcpRuntimeBackend("acp-remote");
      throw new Error("expected ACP backend lookup to fail");
    } catch (error) {
      expect((error as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });
});
