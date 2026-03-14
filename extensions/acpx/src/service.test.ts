import path from "node:path";
import type { AcpRuntime, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/acpx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../src/acp/runtime/errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../src/acp/runtime/registry.js";
import { ACPX_BUNDLED_BIN, ACPX_PINNED_VERSION, type ResolvedAcpxPluginConfig } from "./config.js";
import {
  buildChromeDevToolsMcpPreset,
  CHROME_DEVTOOLS_MCP_BIN,
  createAcpxRuntimeService,
} from "./service.js";

const { ensureAcpxSpy } = vi.hoisted(() => ({
  ensureAcpxSpy: vi.fn(async () => {}),
}));
const { ensureChromeDevToolsMcpSpy } = vi.hoisted(() => ({
  ensureChromeDevToolsMcpSpy: vi.fn(async () => {}),
}));

vi.mock("./ensure.js", () => ({
  ensureAcpx: ensureAcpxSpy,
  ensureChromeDevToolsMcp: ensureChromeDevToolsMcpSpy,
}));

type RuntimeStub = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type RuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: OpenClawPluginServiceContext["logger"];
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

function createRuntimeFactorySpy(runtime: RuntimeStub) {
  return vi.fn((_params: RuntimeFactoryParams) => runtime);
}

function getPassedPluginConfig(
  runtimeFactory: ReturnType<typeof createRuntimeFactorySpy>,
  callIndex = 0,
) {
  const call = runtimeFactory.mock.calls[callIndex];
  expect(call).toBeDefined();
  return call![0].pluginConfig;
}

describe("buildChromeDevToolsMcpPreset", () => {
  it("returns undefined when not enabled", () => {
    expect(buildChromeDevToolsMcpPreset({ existingMcpServers: {} })).toBeUndefined();
    expect(
      buildChromeDevToolsMcpPreset({ browserMcp: { enabled: false }, existingMcpServers: {} }),
    ).toBeUndefined();
  });

  it("returns full-mode config by default", () => {
    const result = buildChromeDevToolsMcpPreset({
      browserMcp: { enabled: true },
      existingMcpServers: {},
    });
    expect(result).toEqual({
      command: CHROME_DEVTOOLS_MCP_BIN,
      args: ["--autoConnect", "--experimental-page-id-routing"],
    });
    expect(path.isAbsolute(result!.command)).toBe(true);
  });

  it("adds --slim flag in slim mode", () => {
    const result = buildChromeDevToolsMcpPreset({
      browserMcp: { enabled: true, mode: "slim" },
      existingMcpServers: {},
    });
    expect(result?.args).toContain("--slim");
  });

  it("adds --channel for non-stable channels", () => {
    const result = buildChromeDevToolsMcpPreset({
      browserMcp: { enabled: true, channel: "canary" },
      existingMcpServers: {},
    });
    expect(result?.args).toContain("--channel=canary");
  });

  it("omits --channel for stable (default)", () => {
    const result = buildChromeDevToolsMcpPreset({
      browserMcp: { enabled: true, channel: "stable" },
      existingMcpServers: {},
    });
    expect(result?.args).not.toContain(expect.stringContaining("--channel"));
  });

  it("returns undefined when existing entry already exists", () => {
    const result = buildChromeDevToolsMcpPreset({
      browserMcp: { enabled: true },
      existingMcpServers: { "chrome-devtools": { command: "custom" } },
    });
    expect(result).toBeUndefined();
  });
});

describe("createAcpxRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
    ensureAcpxSpy.mockReset();
    ensureAcpxSpy.mockImplementation(async () => {});
    ensureChromeDevToolsMcpSpy.mockReset();
    ensureChromeDevToolsMcpSpy.mockImplementation(async () => {});
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
    const runtimeFactory = createRuntimeFactorySpy(runtime);
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
    const runtimeFactory = createRuntimeFactorySpy(runtime);
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

  it("injects chrome-devtools-mcp when browser.mcp.enabled is true", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: { browser: { mcp: { enabled: true } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toEqual({
      command: CHROME_DEVTOOLS_MCP_BIN,
      args: ["--autoConnect", "--experimental-page-id-routing"],
    });
    await vi.waitFor(() => {
      expect(ensureChromeDevToolsMcpSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          command: CHROME_DEVTOOLS_MCP_BIN,
          stripProviderAuthEnvVars: true,
        }),
      );
    });
  });

  it("injects chrome-devtools-mcp in slim mode when configured", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: { browser: { mcp: { enabled: true, mode: "slim" } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toEqual({
      command: CHROME_DEVTOOLS_MCP_BIN,
      args: ["--autoConnect", "--experimental-page-id-routing", "--slim"],
    });
  });

  it("does not inject chrome-devtools-mcp when browser.mcp is not enabled", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({ config: {} });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
  });

  it("skips the preset when browser.enabled is false", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: { browser: { enabled: false, mcp: { enabled: true } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset skipped: browser.enabled=false disables browser.mcp preset injection",
    );
  });

  it("skips the preset when browser.evaluateEnabled is false", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: { browser: { evaluateEnabled: false, mcp: { enabled: true, mode: "slim" } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset skipped: browser.evaluateEnabled=false disables chrome-devtools access",
    );
  });

  it("skips the preset when browser.ssrfPolicy is restrictive", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: {
        browser: {
          mcp: { enabled: true },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        },
      },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset skipped: browser.ssrfPolicy restrictions disable chrome-devtools access",
    );
  });

  it("skips the preset when browser.ssrfPolicy.allowedHostnames is configured", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: {
        browser: {
          mcp: { enabled: true },
          ssrfPolicy: { allowedHostnames: ["docs.openclaw.ai"] },
        },
      },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset skipped: browser.ssrfPolicy restrictions disable chrome-devtools access",
    );
  });

  it("keeps the preset enabled when dangerouslyAllowPrivateNetwork overrides the legacy flag", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({ runtimeFactory });
    const context = createServiceContext({
      config: {
        browser: {
          mcp: { enabled: true },
          ssrfPolicy: {
            allowPrivateNetwork: false,
            dangerouslyAllowPrivateNetwork: true,
          },
        },
      },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toEqual({
      command: CHROME_DEVTOOLS_MCP_BIN,
      args: ["--autoConnect", "--experimental-page-id-routing"],
    });
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset injected from browser.mcp config",
    );
  });

  it("does not override explicit user-defined chrome-devtools entry", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const userDefined = { command: "my-custom-chrome-mcp", args: ["--custom"] };
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: { mcpServers: { "chrome-devtools": userDefined } },
    });
    const context = createServiceContext({
      config: { browser: { mcp: { enabled: true } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toEqual(userDefined);
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools-mcp preset skipped: existing mcpServers entry takes precedence",
    );
    expect(ensureChromeDevToolsMcpSpy).not.toHaveBeenCalled();
  });

  it("keeps explicit chrome-devtools entries when dangerouslyAllowPrivateNetwork overrides the legacy flag", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const userDefined = { command: "/tmp/chrome-devtools-mcp", args: ["--custom"] };
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        mcpServers: {
          "chrome-devtools": userDefined,
          canva: { command: "npx", args: ["canva-mcp"] },
        },
      },
    });
    const context = createServiceContext({
      config: {
        browser: {
          ssrfPolicy: {
            allowPrivateNetwork: false,
            dangerouslyAllowPrivateNetwork: true,
          },
        },
      },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toEqual(userDefined);
    expect(passedConfig.mcpServers["canva"]).toBeDefined();
    expect(context.logger.info).not.toHaveBeenCalledWith(
      "chrome-devtools MCP server removed: browser.ssrfPolicy restrictions disable chrome-devtools access",
    );
  });

  it("removes explicit chrome-devtools entries when browser.enabled is false", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        mcpServers: {
          "chrome-devtools": { command: "/tmp/chrome-devtools-mcp", args: ["--custom"] },
          canva: { command: "npx", args: ["canva-mcp"] },
        },
      },
    });
    const context = createServiceContext({
      config: { browser: { enabled: false } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(passedConfig.mcpServers["canva"]).toBeDefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools MCP server removed: browser.enabled=false disables chrome-devtools access",
    );
  });

  it("removes explicit chrome-devtools entries when browser.evaluateEnabled is false", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        mcpServers: {
          "chrome-devtools": { command: "/tmp/chrome-devtools-mcp", args: ["--custom"] },
          canva: { command: "npx", args: ["canva-mcp"] },
        },
      },
    });
    const context = createServiceContext({
      config: { browser: { evaluateEnabled: false } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(passedConfig.mcpServers["canva"]).toBeDefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools MCP server removed: browser.evaluateEnabled=false disables chrome-devtools access",
    );
  });

  it("removes explicit chrome-devtools entries when browser.ssrfPolicy is restrictive", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        mcpServers: {
          "chrome-devtools": { command: "/tmp/chrome-devtools-mcp", args: ["--custom"] },
          canva: { command: "npx", args: ["canva-mcp"] },
        },
      },
    });
    const context = createServiceContext({
      config: { browser: { ssrfPolicy: { hostnameAllowlist: ["docs.openclaw.ai"] } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(passedConfig.mcpServers["canva"]).toBeDefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools MCP server removed: browser.ssrfPolicy restrictions disable chrome-devtools access",
    );
  });

  it("removes explicit chrome-devtools entries when browser.ssrfPolicy.allowedHostnames is configured", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: {
        mcpServers: {
          "chrome-devtools": { command: "/tmp/chrome-devtools-mcp", args: ["--custom"] },
          canva: { command: "npx", args: ["canva-mcp"] },
        },
      },
    });
    const context = createServiceContext({
      config: { browser: { ssrfPolicy: { allowedHostnames: ["docs.openclaw.ai"] } } },
    });

    await service.start(context);

    const passedConfig = getPassedPluginConfig(runtimeFactory);
    expect(passedConfig.mcpServers["chrome-devtools"]).toBeUndefined();
    expect(passedConfig.mcpServers["canva"]).toBeDefined();
    expect(context.logger.info).toHaveBeenCalledWith(
      "chrome-devtools MCP server removed: browser.ssrfPolicy restrictions disable chrome-devtools access",
    );
  });

  it("does not leak injected preset into subsequent restarts when disabled", async () => {
    const { runtime } = createRuntimeStub(true);
    const runtimeFactory = createRuntimeFactorySpy(runtime);
    const userMcpServers = { canva: { command: "npx", args: ["canva-mcp"] } };
    const service = createAcpxRuntimeService({
      runtimeFactory,
      pluginConfig: { mcpServers: userMcpServers },
    });

    // First start: browser.mcp enabled → preset injected.
    const enabledCtx = createServiceContext({
      config: { browser: { mcp: { enabled: true } } },
    });
    await service.start(enabledCtx);
    expect(getPassedPluginConfig(runtimeFactory).mcpServers["chrome-devtools"]).toBeDefined();

    await service.stop?.(enabledCtx);

    // Second start: browser.mcp disabled → preset must NOT be present.
    const disabledCtx = createServiceContext({ config: {} });
    await service.start(disabledCtx);
    expect(getPassedPluginConfig(runtimeFactory, 1).mcpServers["chrome-devtools"]).toBeUndefined();
    // Original user servers must still be intact.
    expect(getPassedPluginConfig(runtimeFactory, 1).mcpServers["canva"]).toBeDefined();
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
});
