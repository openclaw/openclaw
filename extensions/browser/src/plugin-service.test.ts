import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Browser tests cover plugin service plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserPluginEnableState } from "./plugin-enabled.js";
import { createBrowserPluginService } from "./plugin-service.js";

const SERVICE_CONTEXT = {
  config: {},
  stateDir: "/tmp/openclaw-state",
  logger: console,
};

type StartLazyPluginServiceModuleParams = {
  validateOverrideSpecifier?: (specifier: string) => string;
};
type StartLazyPluginServiceModuleParamsWithValidator = {
  validateOverrideSpecifier: (specifier: string) => string;
};

const runtimeMocks = vi.hoisted(() => ({
  startLazyPluginServiceModule: vi.fn(async (_params: StartLazyPluginServiceModuleParams) => null),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  startLazyPluginServiceModule: runtimeMocks.startLazyPluginServiceModule,
}));

vi.mock("./control-service.js", () => ({
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
}));

describe("createBrowserPluginService", () => {
  beforeEach(() => {
    runtimeMocks.startLazyPluginServiceModule.mockReset().mockResolvedValue(null);
    runtimeMocks.stopBrowserControlService.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function getStartParams(): StartLazyPluginServiceModuleParamsWithValidator {
    const [call] = runtimeMocks.startLazyPluginServiceModule.mock.calls;
    if (!call) {
      throw new Error("expected browser plugin service lazy loader call");
    }
    const [params] = call;
    if (!params?.validateOverrideSpecifier) {
      throw new Error("expected browser plugin service to pass validateOverrideSpecifier");
    }
    return { validateOverrideSpecifier: params.validateOverrideSpecifier };
  }

  const createService = () =>
    createBrowserPluginService({ stopOnDemand: runtimeMocks.stopBrowserControlService });

  it("does not start the control server during gateway startup by default", async () => {
    const service = createService();

    await service.start(SERVICE_CONTEXT);

    expect(runtimeMocks.startLazyPluginServiceModule).not.toHaveBeenCalled();
  });

  it("does not start the control server when eager startup is disabled", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "0");
    const service = createService();

    await service.start(SERVICE_CONTEXT);

    expect(runtimeMocks.startLazyPluginServiceModule).not.toHaveBeenCalled();
  });

  it("passes a browser override validator to the eager service loader", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const service = createService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(params.validateOverrideSpecifier(" ./server.js ")).toBe("./server.js");
  });

  it("rejects unsafe browser override specifiers", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const service = createService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(() => params.validateOverrideSpecifier("data:text/javascript,boom")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("HTTPS://example.invalid/mod.mjs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("node:fs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
  });

  it("stops an on-demand browser runtime even when startup stayed lazy", async () => {
    const service = createService();

    await service.stop?.(SERVICE_CONTEXT);

    expect(runtimeMocks.stopBrowserControlService).toHaveBeenCalledOnce();
  });

  it("propagates on-demand cleanup failures", async () => {
    runtimeMocks.stopBrowserControlService.mockRejectedValueOnce(new Error("cleanup failed"));
    const service = createService();

    await expect(service.stop?.(SERVICE_CONTEXT)).rejects.toThrow("cleanup failed");
  });

  it("retains a loaded service handle until failed cleanup can be retried", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("loaded cleanup failed"))
      .mockResolvedValue(undefined);
    runtimeMocks.startLazyPluginServiceModule.mockResolvedValue({ stop } as never);
    const service = createService();
    await service.start(SERVICE_CONTEXT);

    await expect(service.stop?.(SERVICE_CONTEXT)).rejects.toThrow("loaded cleanup failed");
    await expect(service.stop?.(SERVICE_CONTEXT)).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.stopBrowserControlService).not.toHaveBeenCalled();
  });
});

describe("resolveBrowserPluginEnableState", () => {
  it("defaults to enabled", () => {
    expect(resolveBrowserPluginEnableState({} as OpenClawConfig)).toEqual({ enabled: true });
  });

  it("respects explicit plugin disablement", () => {
    expect(
      resolveBrowserPluginEnableState({
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({ enabled: false, reason: "disabled in config" });
  });
});
