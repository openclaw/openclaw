import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAgentModels } from "acpx/runtime";
import {
  getAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegisteredAcpxService } from "./registration.test-support.js";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "./runtime-api.js";
import setupPlugin from "./setup-api.js";

type BackendLifecycle = {
  publish: (backend: { runtime: unknown }) => void;
  retract: (runtime: unknown) => void;
};
type ServiceOptions = {
  backendLifecycle?: BackendLifecycle;
  getAllowedAgents?: () => string[] | undefined;
  openKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openKeyedStoreV2"];
};

const { realRuntime, startMock, stopMock, createServiceMock, nativePrograms } = vi.hoisted(() => {
  const runtime = {
    async ensureSession({ sessionKey }: { sessionKey: string }) {
      return { backend: "acpx", runtimeSessionName: sessionKey, sessionKey };
    },
  };
  const start = vi.fn(async (hooks?: BackendLifecycle) => hooks?.publish({ runtime }));
  const stop = vi.fn(async (hooks?: BackendLifecycle) => hooks?.retract(runtime));
  return {
    nativePrograms: new Set<string>(),
    realRuntime: runtime,
    startMock: start,
    stopMock: stop,
    createServiceMock: vi.fn((params: ServiceOptions = {}) => ({
      start: () => start(params.backendLifecycle),
      stop: () => stop(params.backendLifecycle),
    })),
  };
});

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
  createAcpxRuntimeService: createServiceMock,
}));

import plugin from "./index.js";

const createRuntimeService = createServiceMock.getMockImplementation();
assert(createRuntimeService);

function createHarnessApi(options: Parameters<typeof createTestPluginApi>[0] = {}) {
  const harnesses = new Map<string, Parameters<OpenClawPluginApi["registerAgentHarness"]>[0]>();
  const api = createTestPluginApi({
    id: "acpx",
    runtime: createPluginRuntimeMock({ config: { current: () => ({}) } }),
    ...options,
    registerAgentHarness: (harness) => harnesses.set(harness.id, harness),
  });
  plugin.register(api);
  return {
    api,
    getHarness(this: void, id: string) {
      const harness = harnesses.get(`acp-${id}`);
      if (!harness || typeof harness.loadModelCatalog !== "function") {
        throw new Error("Native catalog operation missing");
      }
      return { ...harness, loadModelCatalog: harness.loadModelCatalog.bind(harness) };
    },
  };
}

function catalogInput(workspaceDir = "/test/work", config: OpenClawPluginApi["config"] = {}) {
  return { config, agentId: "main", agentDir: workspaceDir, workspaceDir };
}

describe("acpx plugin", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(() => receipts.close());
  beforeEach(() => {
    vi.clearAllMocks();
    nativePrograms.clear();
    createServiceMock.mockImplementation(() => {
      throw new Error("Catalog inspection must not start the runtime");
    });
  });

  it("registers the ACP reply_dispatch hook without starting the runtime", () => {
    const { api } = createHarnessApi({ on: vi.fn() });
    expect(createServiceMock).not.toHaveBeenCalled();
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHook, {
      eligibleDispatchKinds: ["acp"],
    });
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const registerAutoEnableProbe = vi.fn<OpenClawPluginApi["registerAutoEnableProbe"]>();
    setupPlugin.register(createTestPluginApi({ registerAutoEnableProbe }));
    const probe = registerAutoEnableProbe.mock.calls[0]?.[0];
    assert(probe, "expected ACPX setup plugin to register an auto-enable probe");
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
    const { getHarness } = createHarnessApi({
      config,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerGatewayMethod: methods,
      registerReload: reload,
    });
    const registration = methods.mock.calls.find(([method]) => method === "acpx.agents.list");
    assert(registration, "Native agent inspection method missing");
    const handler = registration[1];
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
    const detected = await read();
    expect(detected).toHaveProperty("agents.0", {
      id: "opencode",
      name: "OpenCode",
      runtimeId: "acp-opencode",
      installation: "installed",
      enabled: true,
    });
    expect(detected).toHaveProperty("agents.1.installation", "installed");
    expect(detected).toHaveProperty("agents.2.installation", "missing");
    const opencode = getHarness("opencode");
    const selection = {
      provider: "acp-opencode",
      requestedRuntime: "acp-opencode",
      modelProvider: { endpointOverrides: "none" },
    } as const;
    expect(opencode.supports(selection).supported).toBe(true);
    const missing = getHarness("kilocode");
    await expect(missing.loadModelCatalog(catalogInput(undefined, config))).resolves.toEqual({
      entries: [],
    });
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
    await expect(opencode.loadModelCatalog(catalogInput(undefined, config))).resolves.toEqual({
      entries: [],
    });
    const disabled = await read();
    expect(disabled).toHaveProperty("agents.0.enabled", false);
    expect(disabled).toHaveProperty("agents.1.installation", "unverified");
    expect(disabled).toHaveProperty("agents.2.installation", "installed");
    expect(config.acp?.allowedAgents).toEqual(["codex"]);
    expect(createServiceMock).not.toHaveBeenCalled();
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
      const { getHarness } = createHarnessApi({
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
      const harness = getHarness("opencode");
      const catalog = harness.loadModelCatalog(catalogInput(directory)).then(
        (models) => ({ models, error: undefined }),
        (error: unknown) => ({ models: undefined, error }),
      );
      try {
        const entered = path.join(peerDirectory, "session-new-entered");
        // The peer records entry before replying; its receipt uses a separate pipe.
        await withinTest(Promise.race([receipts.waitFor(entered, ""), catalog]), signal);
        if (lifecycle === "disposed") {
          await harness.dispose?.();
        } else {
          await fs.writeFile(path.join(peerDirectory, "session-new-release"), "");
        }
        const result = await catalog;
        if (lifecycle === "disposed") {
          expect(result.error).toMatchObject({ name: "AbortError" });
        } else {
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
        expect(createServiceMock).not.toHaveBeenCalled();
        await expect(fs.access(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await harness.dispose?.();
        await catalog;
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [undefined, "ready"],
    ["Authentication required: fixture sign-in", "auth-rejected"],
    ["Generic fixture server error", "unavailable"],
  ])(
    "applies env policy and reports native discovery %s without forwarding error data",
    async (message, status) => {
      nativePrograms.add("copilot");
      if (message) {
        vi.mocked(inspectAgentModels).mockRejectedValueOnce(
          Object.assign(new Error(message), {
            name: "RequestError",
            code: -32000,
            data: { privateFixture: "not-for-catalog" },
          }),
        );
      } else {
        vi.mocked(inspectAgentModels).mockResolvedValueOnce(undefined);
      }
      const pluginConfig = {
        agentProcessEnvAllow: ["GH_TOKEN"],
        agentProcessEnvBlock: ["OPENCLAW_GATEWAY_TOKEN"],
      };
      const { getHarness } = createHarnessApi({ pluginConfig });
      await expect(getHarness("copilot").loadModelCatalog(catalogInput())).resolves.toEqual({
        entries: [],
        outcomes: [
          { provider: "acp-copilot", status, ...(message ? { rejectionScope: "catalog" } : {}) },
        ],
      });
      expect(inspectAgentModels).toHaveBeenCalledWith(expect.objectContaining(pluginConfig));
    },
  );
});

type DeferredRuntime = {
  ensureSession(input: { sessionKey: string; agent: string; mode: string }): Promise<unknown>;
};

const session = (runtime: DeferredRuntime, name: string) =>
  runtime.ensureSession({ sessionKey: `agent:codex:acp:${name}`, agent: "codex", mode: "oneshot" });
const activationError = (activation: Promise<unknown>) =>
  activation.catch((error: unknown) => error);
const stoppedDuringActivation = () =>
  expect.objectContaining({ message: "ACPX runtime service stopped during activation" });

describe("acpx register runtime service", () => {
  let ctx: OpenClawPluginServiceContext;
  beforeEach(() => {
    createServiceMock.mockImplementation(createRuntimeService);
    ctx = {
      stateDir: "/tmp/openclaw-acpx-register-test/state",
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", undefined);
  });
  afterEach(() => {
    unregisterAcpRuntimeBackend("acpx");
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  async function start(options: Parameters<typeof createRegisteredAcpxService>[0] = {}) {
    const service = createRegisteredAcpxService(options);
    await service.start(ctx);
    return { service, runtime: getAcpRuntimeBackend("acpx")?.runtime as DeferredRuntime };
  }

  it("registers the acpx backend at startup and starts the real service on first use", async () => {
    const openKeyedStore = vi.fn();
    const { service, runtime } = await start({
      pluginConfig: { timeoutSeconds: 10 },
      runtime: createPluginRuntimeMock({
        config: { current: () => ({ acp: { allowedAgents: ["codex"] } }) },
        state: { openKeyedStoreV2: openKeyedStore },
      }),
    });
    expect(service.id).toBe("acpx-runtime");
    expect(createServiceMock).not.toHaveBeenCalled();
    await session(runtime, "test");
    const params = createServiceMock.mock.calls[0]?.[0];
    expect(params).toMatchObject({ pluginConfig: { timeoutSeconds: 10 } });
    expect(params?.getAllowedAgents?.()).toEqual(["codex"]);
    params?.openKeyedStore?.({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    await service.stop?.(ctx);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it.each(["publication", "probe"])(
    "invalidates startup at %s without retracting a successor",
    async (phase) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      startMock.mockImplementationOnce(async (backendLifecycle) => {
        assert(backendLifecycle, "expected outer backend lifecycle");
        if (phase === "probe") {
          backendLifecycle.publish({ runtime: realRuntime });
        }
        entered.resolve();
        await release.promise;
        if (phase === "publication") {
          backendLifecycle.publish({ runtime: realRuntime });
        }
      });
      const { service: generationA, runtime: runtimeA } = await start();
      const activationResult = activationError(session(runtimeA, "generation-a"));
      await entered.promise;
      expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtimeA);
      const settled = vi.fn();
      const concurrentCallResult = activationError(session(runtimeA, "generation-a-concurrent"));
      void concurrentCallResult.then(settled);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).not.toHaveBeenCalled();
      const stoppingA = generationA.stop?.(ctx);
      await Promise.resolve();
      expect(stopMock).not.toHaveBeenCalled();
      expect(getAcpRuntimeBackend("acpx")).toBeNull();
      const { service: generationB, runtime: runtimeB } = await start();
      expect(runtimeB).not.toBe(runtimeA);
      expect(runtimeB).not.toBe(realRuntime);
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      await stoppingA;

      expect(stopMock).toHaveBeenCalledOnce();
      expect(await activationResult).toEqual(stoppedDuringActivation());
      expect(await concurrentCallResult).toEqual(stoppedDuringActivation());
      expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtimeB);
      await expect(session(runtimeA, "stale-generation-a")).rejects.toThrow(
        "ACPX runtime service is not started",
      );

      await generationB.stop?.(ctx);
      expect(getAcpRuntimeBackend("acpx")).toBeNull();
    },
  );

  it("keeps the explicit runtime skip env as the only outer startup skip", async () => {
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", "1");
    await start();

    expect(createServiceMock).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });
});
