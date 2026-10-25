import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAgentModels } from "acpx/runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
          command === process.execPath
            ? command
            : nativePrograms.has(command)
              ? `/installed/${command}`
              : undefined,
        resolvePackageRoot: () => undefined,
      }),
  };
});

vi.mock("acpx/runtime", async (importActual) => {
  const { inspectAgentModels: inspect } = await importActual<typeof import("acpx/runtime")>();
  return { inspectAgentModels: vi.fn(inspect) };
});

// mock-isolation: native catalog inspection must not start the lazy runtime service.
vi.mock("./src/service.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime-backend")>()),
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin from "./index.js";

function createHarnessApi(options: Parameters<typeof createTestPluginApi>[0]) {
  const harnesses = new Map<string, Parameters<OpenClawPluginApi["registerAgentHarness"]>[0]>();
  return {
    api: createTestPluginApi({
      id: "acpx",
      ...options,
      registerAgentHarness: (harness) => {
        harnesses.set(harness.id, harness);
      },
    }),
    getHarness(this: void, id: string) {
      const harness = harnesses.get(`acp-${id}`);
      if (!harness?.loadModelCatalog) {
        throw new Error("Native catalog operation missing");
      }
      return { ...harness, loadModelCatalog: harness.loadModelCatalog.bind(harness) };
    },
  };
}

function catalogInput(
  config: OpenClawPluginApi["config"],
  agentDir = "/test/agent",
  workspaceDir = "/test/work",
) {
  return { config, agentId: "main", agentDir, workspaceDir };
}

function expectedAgents(enabled: boolean) {
  return {
    agents: [
      ["opencode", "OpenCode", "installed"],
      ["qwen", "Qwen Code", enabled ? "installed" : "unverified"],
      ["pi", "Pi", enabled ? "missing" : "installed"],
      ["kilocode", "Kilo Code", "missing"],
      ["copilot", "GitHub Copilot", "installed"],
    ].map(([id, name, installation]) => ({
      id,
      name,
      runtimeId: `acp-${id}`,
      installation,
      enabled,
    })),
  };
}

describe("acpx plugin", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(() => receipts.close());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    nativePrograms.clear();
    createAcpxRuntimeServiceMock.mockImplementation(() => {
      throw new Error("Catalog inspection must not start the runtime");
    });
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: createPluginRuntimeMock(),
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(createAcpxRuntimeServiceMock).not.toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acpx-runtime",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHookMock, {
      eligibleDispatchKinds: ["acp"],
    });
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    let probe: Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0] | undefined;
    setupPlugin.register(
      createTestPluginApi({
        registerAutoEnableProbe(registered) {
          probe = registered;
        },
      }),
    );
    if (!probe) {
      throw new Error("expected ACPX setup plugin to register an auto-enable probe");
    }
    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });

  it("detects native programs and applies current enable settings without starting the runtime", async () => {
    for (const command of ["npx", "opencode", "qwen", "pi-acp", "copilot"]) {
      nativePrograms.add(command);
    }
    let config: OpenClawPluginApi["config"] = { acp: { allowedAgents: ["codex"] } };
    const methods = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
    const reload = vi.fn<OpenClawPluginApi["registerReload"]>();
    const { api, getHarness } = createHarnessApi({
      config,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerGatewayMethod: methods,
      registerReload: reload,
    });
    plugin.register(api);
    const registration = methods.mock.calls.find(([method]) => method === "acpx.agents.list");
    if (!registration) {
      throw new Error("Native agent inspection method missing");
    }
    let handler = registration[1];
    expect(registration[2]).toEqual({ scope: "operator.read", profileAccess: "independent" });
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
    expect(await read()).toEqual(expectedAgents(true));
    const opencode = getHarness("opencode");
    const selection = {
      provider: "acp-opencode",
      requestedRuntime: "acp-opencode",
      modelProvider: { endpointOverrides: "none" },
    } as const;
    expect(opencode.supports(selection).supported).toBe(true);
    const missing = getHarness("kilocode");
    await expect(missing.loadModelCatalog(catalogInput(config))).resolves.toEqual({ entries: [] });
    expect(inspectAgentModels).not.toHaveBeenCalled();
    nativePrograms.add("pi");
    const pluginConfig = {
      nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false, copilot: false },
      agents: { qwen: { command: "npx qwen" } },
    };
    config = {
      ...config,
      plugins: { entries: { acpx: { config: pluginConfig } } },
    };
    expect(opencode.supports(selection).supported).toBe(false);
    await expect(opencode.loadModelCatalog(catalogInput(config))).resolves.toEqual({ entries: [] });
    const disabled = expectedAgents(false);
    expect(await read()).toEqual(disabled);
    plugin.register(api);
    const replacement = methods.mock.calls.findLast(([method]) => method === "acpx.agents.list");
    if (!replacement) {
      throw new Error("Native method missing after registration");
    }
    handler = replacement[1];
    expect(await read()).toEqual(disabled);
    expect(config.acp?.allowedAgents).toEqual(["codex"]);
    expect(createAcpxRuntimeServiceMock).not.toHaveBeenCalled();
  });

  it.for(["enabled", "disposed"] as const)(
    "inspects a real native catalog without runtime state when the harness becomes %s",
    async (lifecycle, { signal }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-native-catalog-"));
      const peerDirectory = path.join(directory, "peer");
      await fs.mkdir(peerDirectory);
      const receiptModule = path.join(directory, "receipts.mjs");
      await fs.writeFile(
        receiptModule,
        `${fixtureReceiptClientSource(receipts.endpoint)}
export { sendReceipt };`,
      );
      const runtimeDirectory = path.join(directory, "runtime");
      const config: OpenClawPluginApi["config"] = {};
      const { api, getHarness } = createHarnessApi({
        config,
        pluginConfig: {
          stateDir: runtimeDirectory,
          timeoutSeconds: 10,
          agents: {
            opencode: {
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../../test/fixtures/acp/owner-agent.mjs", import.meta.url)),
                peerDirectory,
                "--model-controls",
                "--hold-new-session",
                `--receipt-module=${receiptModule}`,
              ],
            },
          },
        },
        runtime: createPluginRuntimeMock({
          config: { current: () => config },
          state: {
            resolveStateDir: () => {
              throw new Error("Catalog inspection must not resolve runtime state");
            },
            openKeyedStoreV2: () => {
              throw new Error("Catalog inspection must not open runtime state");
            },
          },
        }),
      });
      plugin.register(api);
      const harness = getHarness("opencode");
      const catalog = harness.loadModelCatalog(catalogInput(config, directory, directory)).then(
        (models) => ({ models, error: undefined }),
        (error: unknown) => ({ models: undefined, error }),
      );
      try {
        const entered = path.join(peerDirectory, "session-new-entered");
        // The peer records entry before replying; its receipt uses a separate pipe.
        await withinTest(
          Promise.race([
            receipts.waitFor(entered, ""),
            catalog.then(async () => {
              expect(await fs.readFile(entered, "utf8")).not.toBe("");
            }),
          ]),
          signal,
        );
        if (lifecycle === "disposed") {
          await harness.dispose?.();
        } else {
          await fs.writeFile(path.join(peerDirectory, "session-new-release"), "");
        }
        const result = await catalog;
        if (lifecycle === "disposed") {
          expect(result.error).toMatchObject({ name: "AbortError" });
          expect(result.models).toBeUndefined();
        } else {
          expect(result.error).toBeUndefined();
          expect(result.models).toEqual({
            entries: [
              ["initial", "Initial"],
              ["selected", "Selected"],
            ].map(([id, name]) => ({
              provider: "acp-opencode",
              id,
              name,
              nativeRuntime: "acp-opencode",
            })),
            outcomes: [{ provider: "acp-opencode", status: "ready" }],
          });
        }
        const sessionId = await fs.readFile(entered, "utf8");
        const nativeSession = JSON.parse(
          await fs.readFile(path.join(peerDirectory, `${sessionId}.json`), "utf8"),
        ) as { history: string[]; mcpServers: unknown[] };
        expect([nativeSession.history, nativeSession.mcpServers]).toEqual([[], []]);
        expect(createAcpxRuntimeServiceMock).not.toHaveBeenCalled();
        await expect(fs.access(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await harness.dispose?.();
        await catalog;
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("applies configured agent env lists to native catalog inspection", async () => {
    nativePrograms.add("copilot");
    vi.mocked(inspectAgentModels).mockResolvedValueOnce(undefined);
    const { api, getHarness } = createHarnessApi({
      pluginConfig: {
        agentProcessEnvAllow: ["GH_TOKEN"],
        agentProcessEnvBlock: ["OPENCLAW_GATEWAY_TOKEN"],
      },
      runtime: createPluginRuntimeMock({ config: { current: () => ({}) } }),
    });
    plugin.register(api);
    await getHarness("copilot").loadModelCatalog(catalogInput({}));
    expect(inspectAgentModels).toHaveBeenCalledWith(
      expect.objectContaining({
        agentProcessEnvAllow: ["GH_TOKEN"],
        agentProcessEnvBlock: ["OPENCLAW_GATEWAY_TOKEN"],
      }),
    );
  });

  it.each([
    ["Authentication required: fixture sign-in", "auth-rejected"],
    ["Generic fixture server error", "unavailable"],
  ])(
    "attributes native discovery RequestError/-32000/%s without forwarding error data",
    async (message, status) => {
      nativePrograms.add("copilot");
      const error = Object.assign(new Error(message), {
        name: "RequestError",
        code: -32000,
        data: { privateFixture: "not-for-catalog" },
      });
      vi.mocked(inspectAgentModels).mockRejectedValueOnce(error);
      const { api, getHarness } = createHarnessApi({
        runtime: createPluginRuntimeMock({ config: { current: () => ({}) } }),
      });
      plugin.register(api);
      const harness = getHarness("copilot");
      await expect(
        harness.loadModelCatalog(catalogInput({}, "/fixture/agent", "/fixture/work")),
      ).resolves.toEqual({
        entries: [],
        outcomes: [{ provider: "acp-copilot", status, rejectionScope: "catalog" }],
      });
      expect(inspectAgentModels).toHaveBeenCalledOnce();
    },
  );
});
