import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import setupPlugin from "./setup-api.js";

const { createAcpxRuntimeServiceMock, tryDispatchAcpReplyHookMock, nativePrograms } = vi.hoisted(
  () => ({
    createAcpxRuntimeServiceMock: vi.fn(),
    tryDispatchAcpReplyHookMock: vi.fn(),
    nativePrograms: new Set<string>(),
  }),
);

vi.mock("acpx/agent-registry", async (importActual) => {
  const actual = await importActual<typeof import("acpx/agent-registry")>();
  return {
    createAgentRegistry: (options: Parameters<typeof actual.createAgentRegistry>[0]) =>
      actual.createAgentRegistry({
        ...options,
        resolveExecutable: (command) =>
          nativePrograms.has(command) ? `/installed/${command}` : undefined,
        resolvePackageRoot: () => undefined,
      }),
  };
});

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("acpx plugin", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    nativePrograms.clear();
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    const openKeyedStore = vi.fn();

    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
      openKeyedStore: expect.any(Function),
    });
    const params = createAcpxRuntimeServiceMock.mock.calls[0]?.[0] as {
      openKeyedStore: typeof openKeyedStore;
    };
    params.openKeyedStore({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHookMock, {
      eligibleDispatchKinds: ["acp"],
    });
  });

  it("does not touch runtime state while registering metadata-only plugin APIs", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = createTestPluginApi({
      pluginConfig: {},
      runtime: {} as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerService).toHaveBeenCalledWith(service);
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });

  it("detects native programs and applies current enable settings without starting the runtime", async () => {
    for (const command of ["npx", "opencode", "qwen", "pi-acp"]) {
      nativePrograms.add(command);
    }
    const getRuntime = vi.fn(() => {
      throw new Error("Inspection must not start the runtime");
    });
    createAcpxRuntimeServiceMock.mockReturnValue({ id: "acpx", getRuntime });
    let config: OpenClawPluginApi["config"] = { acp: { allowedAgents: ["codex"] } };
    const methods = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
    const reload = vi.fn<OpenClawPluginApi["registerReload"]>();
    const harnesses = new Map<string, Parameters<OpenClawPluginApi["registerAgentHarness"]>[0]>();
    const api = createTestPluginApi({
      id: "acpx",
      config,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerGatewayMethod: methods,
      registerReload: reload,
      registerAgentHarness: (harness) => {
        harnesses.set(harness.id, harness);
      },
    });
    plugin.register(api);
    const registration = methods.mock.calls.find(([method]) => method === "acpx.agents.list");
    if (!registration) {
      throw new Error("Native agent inspection method missing");
    }
    let handler = registration[1];
    const scope = registration[2];
    expect(scope).toEqual({ scope: "operator.read", profileAccess: "independent" });
    expect(reload).toHaveBeenCalledWith({
      noopPrefixes: ["plugins.entries.acpx.config.nativeAgents"],
    });
    const read = async () => {
      const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
      await handler({
        req: { type: "req", id: "inspect", method: "acpx.agents.list" },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        get context(): never {
          throw new Error("Installation inspection must not read session state");
        },
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    expect(await read()).toEqual({
      agents: [
        {
          id: "opencode",
          name: "OpenCode",
          runtimeId: "acp-opencode",
          installation: "installed",
          enabled: true,
        },
        {
          id: "qwen",
          name: "Qwen Code",
          runtimeId: "acp-qwen",
          installation: "installed",
          enabled: true,
        },
        { id: "pi", name: "Pi", runtimeId: "acp-pi", installation: "missing", enabled: true },
        {
          id: "kilocode",
          name: "Kilo Code",
          runtimeId: "acp-kilocode",
          installation: "missing",
          enabled: true,
        },
      ],
    });
    const opencode = harnesses.get("acp-opencode");
    if (!opencode?.loadModelCatalog) {
      throw new Error("Native catalog operation missing");
    }
    const selection = {
      provider: "acp-opencode",
      requestedRuntime: "acp-opencode",
      modelProvider: { endpointOverrides: "none" },
    } as const;
    expect(opencode.supports(selection).supported).toBe(true);
    nativePrograms.add("pi");
    config = {
      ...config,
      plugins: {
        entries: {
          acpx: {
            config: {
              nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false },
              agents: { qwen: { command: "npx qwen" } },
            },
          },
        },
      },
    };
    expect(opencode.supports(selection).supported).toBe(false);
    await expect(
      opencode.loadModelCatalog({
        config,
        agentId: "main",
        agentDir: "/test/agent",
        workspaceDir: "/test/work",
      }),
    ).resolves.toEqual([]);
    const disabled = {
      agents: [
        {
          id: "opencode",
          name: "OpenCode",
          runtimeId: "acp-opencode",
          installation: "installed",
          enabled: false,
        },
        {
          id: "qwen",
          name: "Qwen Code",
          runtimeId: "acp-qwen",
          installation: "unverified",
          enabled: false,
        },
        { id: "pi", name: "Pi", runtimeId: "acp-pi", installation: "installed", enabled: false },
        {
          id: "kilocode",
          name: "Kilo Code",
          runtimeId: "acp-kilocode",
          installation: "missing",
          enabled: false,
        },
      ],
    };
    expect(await read()).toEqual(disabled);
    plugin.register(api);
    const replacement = methods.mock.calls.findLast(([method]) => method === "acpx.agents.list");
    if (!replacement) {
      throw new Error("Native method missing after registration");
    }
    handler = replacement[1];
    expect(await read()).toEqual(disabled);
    expect(config.acp?.allowedAgents).toEqual(["codex"]);
    expect(getRuntime).not.toHaveBeenCalled();
  });
});
