import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaGatewayChild, startQaProviderServer, gatewayStop } = vi.hoisted(() => ({
  startQaGatewayChild: vi.fn(),
  gatewayStop: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("../../gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => startQaGatewayChild(params),
    stop: gatewayStop,
  }),
}));

vi.mock("../../providers/server-runtime.js", () => ({
  startQaProviderServer,
}));

import { createQaLiveLaneGateway } from "./live-gateway.runtime.js";

type StartOptions = Parameters<ReturnType<typeof createQaLiveLaneGateway>["start"]>[0];
function gatewayParams(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    repoRoot: "/tmp/openclaw-repo",
    transport: {
      requiredPluginIds: ["qa-channel"],
      createGatewayConfig: ({ baseUrl }) => ({
        channels: { "qa-channel": { enabled: true, baseUrl } },
      }),
    },
    transportBaseUrl: "http://127.0.0.1:43123",
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    controlUiEnabled: false,
    ...overrides,
  };
}

function firstGatewayOptions() {
  return startQaGatewayChild.mock.calls[0]?.[0] as
    | (Partial<StartOptions> & { providerBaseUrl?: string })
    | undefined;
}

describe("createQaLiveLaneGateway", () => {
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();
  const owners: ReturnType<typeof createQaLiveLaneGateway>[] = [];
  const ownGateway = () => {
    const owner = createQaLiveLaneGateway();
    owners.push(owner);
    return owner;
  };
  const start = (overrides: Partial<StartOptions> = {}) =>
    ownGateway().start(gatewayParams(overrides));

  beforeEach(() => {
    gatewayStop.mockReset().mockResolvedValue({ process: "confirmed-stopped", errors: [] });
    for (const mock of [gatewayCall, mockStop, startQaGatewayChild, startQaProviderServer]) {
      mock.mockReset();
    }

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall,
      cfg: {},
      stop: gatewayStop,
    });
    startQaProviderServer.mockImplementation(async (providerMode: string) =>
      providerMode === "mock-openai" ? { baseUrl: "http://127.0.0.1:44080", stop: mockStop } : null,
    );
  });

  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      await owner.stop();
    }
    vi.clearAllMocks();
  });

  it("exposes unconfirmed teardown even when startup never returns a ready handle", async () => {
    const startupError = new Error("gateway startup failed");
    const stopError = new Error("gateway group still alive");
    startQaGatewayChild.mockRejectedValueOnce(startupError);
    gatewayStop.mockResolvedValue({ process: "unconfirmed", errors: [stopError] });
    const owner = createQaLiveLaneGateway();
    await expect(owner.start(gatewayParams())).rejects.toBe(startupError);
    await expect(owner.stop()).resolves.toEqual({ process: "unconfirmed", errors: [stopError] });
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("closes child admission while provider startup is pending", async () => {
    const provider = Promise.withResolvers<{ baseUrl: string; stop: typeof mockStop }>();
    startQaProviderServer.mockReturnValueOnce(provider.promise);
    gatewayStop.mockResolvedValue({ process: "never-spawned", errors: [] });
    const owner = createQaLiveLaneGateway();
    const startup = owner.start(gatewayParams());
    const rejection = expect(startup).rejects.toThrow("lifecycle is closed");
    const stopping = owner.stop();
    provider.resolve({ baseUrl: "http://127.0.0.1:44080", stop: mockStop });
    await rejection;
    await expect(stopping).resolves.toEqual({ process: "never-spawned", errors: [] });
    expect(startQaGatewayChild).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it.each(["mock-openai", "live-frontier"] as const)(
    "starts and stops the %s lane with the selected runtime",
    async (providerMode) => {
      const primaryModel = `${providerMode === "mock-openai" ? "mock-openai" : "openai"}/gpt-5.6-luna`;
      const alternateModel = providerMode === "mock-openai" ? `${primaryModel}-alt` : primaryModel;
      const harness = await start({
        providerMode,
        primaryModel,
        alternateModel,
        forcedRuntime: "codex",
      });
      expect(startQaProviderServer).toHaveBeenCalledWith(providerMode, {
        modelRefs: [primaryModel, alternateModel],
      });
      expect(firstGatewayOptions()).toMatchObject({
        transportBaseUrl: "http://127.0.0.1:43123",
        providerBaseUrl: providerMode === "mock-openai" ? "http://127.0.0.1:44080/v1" : undefined,
        providerMode,
        forcedRuntime: "codex",
      });
      const options = { preserveToDir: ".artifacts/qa-e2e/debug" };
      await harness.stop(options);
      expect(gatewayStop).toHaveBeenCalledExactlyOnceWith(options);
      expect(mockStop).toHaveBeenCalledTimes(providerMode === "mock-openai" ? 1 : 0);
    },
  );

  it("disables memory search for transport-only live lanes", async () => {
    await start();

    const { mutateConfig } = firstGatewayOptions() ?? {};
    if (!mutateConfig) {
      throw new Error("expected gateway config mutator");
    }
    const cfg = mutateConfig({
      plugins: {
        allow: ["acpx", "memory-core", "qa-channel"],
        entries: {
          acpx: { enabled: true },
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
        slots: {
          memory: "memory-core",
          contextEngine: "custom-context",
        },
      },
      memory: { search: { enabled: true } },
    });

    expect(cfg.plugins?.allow).toEqual(["acpx", "qa-channel"]);
    expect(cfg.plugins?.slots).toEqual({ memory: "none", contextEngine: "custom-context" });
    expect(cfg.memory?.search?.enabled).toBe(false);
    expect(cfg.plugins?.entries).not.toHaveProperty("memory-core");
  });

  it.each([false, true])(
    "finalizes failed startup (mock cleanup failure: %s)",
    async (cleanupFails) => {
      const owner = ownGateway();
      startQaGatewayChild.mockRejectedValueOnce(new Error("gateway failed"));
      if (cleanupFails) {
        mockStop.mockRejectedValueOnce(new Error("mock stuck"));
      }
      await expect(owner.start(gatewayParams())).rejects.toThrow("gateway failed");

      const options = { preserveToDir: ".artifacts/qa-e2e/debug" };
      await expect(owner.stop(options)).resolves.toEqual({
        process: "confirmed-stopped",
        errors: cleanupFails ? [expect.objectContaining({ message: "mock stuck" })] : [],
      });
      expect(gatewayStop).toHaveBeenCalledWith(options);
      expect(mockStop).toHaveBeenCalledTimes(1);
    },
  );

  it("reports both gateway and mock shutdown failures together", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway down")],
    });
    mockStop.mockRejectedValueOnce(new Error("mock down"));
    const harness = await start();

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources: gateway down; mock down",
    );
  });

  it.each(["mock", "gateway"] as const)("retries only failed %s cleanup", async (failed) => {
    if (failed === "mock") {
      mockStop.mockRejectedValueOnce(new Error("mock down"));
    } else {
      gatewayStop.mockResolvedValueOnce({
        process: "unconfirmed",
        errors: [new Error("gateway down")],
      });
    }
    const harness = await start();
    const stopOptions = { preserveToDir: ".artifacts/qa-e2e/debug" };
    await expect(harness.stop(stopOptions)).rejects.toThrow(`${failed} down`);
    expect(mockStop).toHaveBeenCalledTimes(1);
    await expect(harness.stop(stopOptions)).resolves.toBeUndefined();
    expect(startQaGatewayChild).toHaveBeenCalledOnce();
    expect(gatewayStop).toHaveBeenCalledWith(stopOptions);
    if (failed === "gateway") {
      expect(gatewayStop).toHaveBeenCalledTimes(2);
    }
    expect(mockStop).toHaveBeenCalledTimes(failed === "mock" ? 2 : 1);
  });
});
