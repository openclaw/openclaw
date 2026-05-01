import type { AcpRuntime, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/acpx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../src/acp/runtime/registry.js";
import { CODEX_SDK_BACKEND_ID } from "./config.js";
import { createCodexSdkRuntimeService } from "./service.js";

type RuntimeStub = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

function createRuntimeStub(healthy: boolean): {
  runtime: RuntimeStub;
  probeAvailabilitySpy: ReturnType<typeof vi.fn>;
} {
  const probeAvailabilitySpy = vi.fn(async () => {});
  return {
    runtime: {
      ensureSession: vi.fn(async (input) => ({
        sessionKey: input.sessionKey,
        backend: CODEX_SDK_BACKEND_ID,
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
        return healthy;
      },
    },
    probeAvailabilitySpy,
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

describe("createCodexSdkRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and unregisters the codex-sdk backend", async () => {
    const { runtime, probeAvailabilitySpy } = createRuntimeStub(true);
    const service = createCodexSdkRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createServiceContext();

    await service.start(context);
    expect(getAcpRuntimeBackend(CODEX_SDK_BACKEND_ID)?.runtime).toBe(runtime);

    await vi.waitFor(() => {
      expect(probeAvailabilitySpy).toHaveBeenCalledOnce();
    });

    await service.stop?.(context);
    expect(getAcpRuntimeBackend(CODEX_SDK_BACKEND_ID)).toBeNull();
  });

  it("marks the backend unavailable when health is false", async () => {
    const { runtime } = createRuntimeStub(false);
    const service = createCodexSdkRuntimeService({
      runtimeFactory: () => runtime,
    });

    await service.start(createServiceContext());

    expect(() => requireAcpRuntimeBackend(CODEX_SDK_BACKEND_ID)).toThrowError(AcpRuntimeError);
  });
});
