import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  peekSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "./agent-bundle-mcp-manager-cleanup.js";
import { unopenedMcpConfig } from "./agent-bundle-mcp-manager.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntimeLease } from "./agent-bundle-mcp-types.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import {
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-runner/cli-run-settlement.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  bindActiveOperatorTurnAuthority,
  type CronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const mocks = vi.hoisted(() => {
  const scheduler: { clock?: GatewaySchedulerClock } = {};
  return {
    prepare: vi.fn(),
    resolveDeps: vi.fn(async () => ({})),
    resolveTransport: vi.fn(),
    scheduler,
  };
});

vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const { GatewayScheduler } =
    await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    GatewayScheduler: class extends GatewayScheduler {
      constructor(options: ConstructorParameters<typeof GatewayScheduler>[0] = {}) {
        super({ ...options, clock: options.clock ?? mocks.scheduler.clock });
      }
    },
  };
});

vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: mocks.prepare,
}));

vi.mock("./command/runtime-loaders.js", () => ({
  resolveAgentCommandDeps: mocks.resolveDeps,
}));

vi.mock("./mcp-transport.js", () => ({ resolveMcpTransport: mocks.resolveTransport }));

let state: OpenClawTestState;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
beforeEach(async () => {
  await disposeAllSessionMcpRuntimes();
  // A drained manager still retains the previous file's transport loader.
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  clock = createGatewaySchedulerClock();
  mocks.scheduler.clock = clock.clock;
  state = await createOpenClawTestState({ label: "local-command-authority" });
});
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  mocks.resolveTransport.mockReset();
  await resetPreparedModelRuntimeSnapshotsForTest();
  await clearActivePluginRegistry();
  await state.cleanup();
});

function createPrepared(senderIsOwner: boolean) {
  return {
    cfg: {},
    opts: { runId: "run-local", senderIsOwner },
    runId: "run-local",
    sessionAgentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
  };
}

function runCommand<T>(
  run: Parameters<typeof runLocalAgentCommand<T>>[0]["run"],
  overrides: Partial<Omit<Parameters<typeof runLocalAgentCommand<T>>[0], "run">> = {},
) {
  return runLocalAgentCommand({
    opts: { message: "test", runId: "run-local" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...overrides,
    run,
  });
}

function createHost(schedulerClock = clock) {
  const scheduler = createTestGatewayScheduler(schedulerClock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  return { host, scheduler };
}

function acquireMcp(sessionId: string) {
  return acquireSessionMcpRuntime({
    sessionId,
    workspaceDir: state.workspaceDir,
    cfg: unopenedMcpConfig,
  });
}

function boundHost() {
  const host = getBoundLegacyPluginSdkResourceHost();
  if (!host) {
    throw new Error("Local command did not bind its resource host");
  }
  return host;
}

async function expectProbe(runtime: SessionMcpRuntimeLease["runtime"] | undefined, text: string) {
  await expect(runtime?.callTool("fixture", "probe", {})).resolves.toMatchObject({
    content: [{ type: "text", text }],
  });
}

function blockRelease<T extends unknown[]>(release: (...args: T) => Promise<void>) {
  const started = createDeferred();
  const finish = createDeferred();
  return {
    started: started.promise,
    finish: () => finish.resolve(),
    release: async (...args: T) => {
      started.resolve();
      await finish.promise;
      await release(...args);
    },
  };
}

async function createMcpPeer(label: string) {
  const server = new McpServer({ name: label, version: "1" });
  server.registerTool("probe", {}, async () => ({ content: [{ type: "text", text: label }] }));
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  mocks.resolveTransport.mockReturnValueOnce({
    transport,
    description: label,
    transportType: "stdio",
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    supportsParallelToolCalls: true,
  });
  return { server, transport };
}

async function exerciseMcpRuntime(sessionId: string, text: string) {
  const lease = await acquireMcp(sessionId);
  try {
    expect((await lease.runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
      "probe",
    ]);
    await expectProbe(lease.runtime, text);
    return lease.runtime;
  } finally {
    await releaseSessionMcpRuntime(lease);
  }
}

it.each([
  ["owned success", false, false, false],
  ["owned revoked preparation", false, false, true],
  ["borrowed retained", true, false, false],
  ["borrowed cleanup", true, true, false],
] as const)(
  "settles %s without retiring another session",
  async (_name, borrowed, cleanup, preparationFailure) => {
    const survivor = await createMcpPeer("survivor");
    const commandPeer = await createMcpPeer("command");
    const survivorClock = createGatewaySchedulerClock();
    const { host, scheduler } = createHost(survivorClock);
    const closeTransport = commandPeer.transport.close.bind(commandPeer.transport);
    // Bind the original before replacing it so release does not reenter the spy.
    const closing = blockRelease(closeTransport);
    vi.spyOn(commandPeer.transport, "close").mockImplementationOnce(closing.release);
    const revoked = new Error("preparation authority revoked");
    const result = { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    let settled = false;
    let command: ReturnType<typeof settlePreparedCliRun> | undefined;
    try {
      const retained = await host.run(() => exerciseMcpRuntime("survivor-mcp", "survivor"));
      const maintenance = vi.fn();
      scheduler.schedule({ id: "survivor-maintenance", delayMs: 10, run: maintenance });
      mocks.prepare.mockImplementationOnce(async (opts: AgentCommandOpts) => ({
        ...createPrepared(false),
        opts,
      }));
      const run = () =>
        runCommand(
          async (prepared) => {
            const context = buildPreparedCliRunContext({
              sessionId: "command-mcp",
              runId: prepared.runId,
              workspaceDir: state.workspaceDir,
            });
            context.params.cleanupBundleMcpOnRunEnd = prepared.opts.cleanupBundleMcpOnRunEnd;
            if (preparationFailure) {
              await exerciseMcpRuntime("command-mcp", "command");
              await settleCliPreparationError(new Error("preparation failed"), {
                ...context.params,
                assertCurrent: () => {
                  throw revoked;
                },
              });
              throw new Error("Revoked preparation unexpectedly settled");
            }
            return await settlePreparedCliRun({
              context,
              run: async () => {
                await exerciseMcpRuntime("command-mcp", "command");
                return result;
              },
            });
          },
          {
            opts: { message: "test", runId: "run-local", cleanupBundleMcpOnRunEnd: cleanup },
          },
        ).finally(() => {
          settled = true;
        });
      command = borrowed ? host.run(run) : run();
      void command.catch(() => undefined);
      const retires = !borrowed || cleanup;
      if (retires) {
        await Promise.race([closing.started, command.catch(() => undefined)]);
        expect(settled).toBe(false);
        closing.finish();
      }
      if (preparationFailure) {
        await expect(command).rejects.toBe(revoked);
      } else {
        await expect(command).resolves.toEqual(result);
      }
      if (retires) {
        expect(peekSessionMcpRuntime({ sessionId: "command-mcp" })).toBeUndefined();
        await expect(
          commandPeer.transport.send({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        ).rejects.toThrow("Not connected");
      } else {
        await expectProbe(peekSessionMcpRuntime({ sessionId: "command-mcp" }), "command");
      }
      await expectProbe(retained, "survivor");
      await survivorClock.advanceBy(10);
      expect(maintenance).toHaveBeenCalledOnce();
    } finally {
      closing.finish();
      await command?.catch(() => undefined);
      await disposeAllSessionMcpRuntimes();
      await scheduler.stop();
      await host.close();
      await Promise.all([survivor.server.close(), commandPeer.server.close()]);
    }
  },
);
it.each([
  { outcome: "success", cleanupFails: false },
  { outcome: "preparation failure", cleanupFails: false },
  { outcome: "execution failure", cleanupFails: false },
  { outcome: "success", cleanupFails: true },
  { outcome: "preparation failure", cleanupFails: true },
  { outcome: "execution failure", cleanupFails: true },
])(
  "joins owned resources after $outcome (cleanup failure=$cleanupFails) and cancels their scheduled work",
  async ({ outcome, cleanupFails }) => {
    const failure = new Error(outcome);
    const cleanupFailure = new Error("resource release failed");
    const maintenance = vi.fn();
    let host: LegacyPluginSdkResourceHost | undefined;
    let acquired: SessionMcpRuntimeLease | undefined;
    const releasing = blockRelease(async (lease: SessionMcpRuntimeLease) => {
      await releaseSessionMcpRuntime(lease);
      if (cleanupFails) {
        throw cleanupFailure;
      }
    });
    mocks.prepare.mockImplementationOnce(async () => {
      host = boundHost();
      const lease = await acquireMcp("local-mcp");
      acquired = lease;
      host.adopt(lease.runtime, { release: () => releasing.release(lease) });
      host.scheduler.schedule({ id: "local-maintenance", delayMs: 10, run: maintenance });
      if (outcome === "preparation failure") {
        throw failure;
      }
      return createPrepared(false);
    });
    let settled = false;
    const command = runCommand(async () => {
      if (outcome === "execution failure") {
        throw failure;
      }
      return "done";
    }).finally(() => {
      settled = true;
    });
    void command.catch(() => undefined);
    try {
      await Promise.race([releasing.started, command]);
      expect(settled).toBe(false);
      expect(acquired?.runtime.activeLeases).toBe(1);
      expect(clock.armedAtMs).toBeNull();
      await clock.advanceBy(10);
      expect(maintenance).not.toHaveBeenCalled();

      releasing.finish();
      if (cleanupFails && outcome !== "success") {
        await expect(command).rejects.toMatchObject({
          errors: [failure, expect.objectContaining({ errors: [cleanupFailure] })],
          cause: expect.objectContaining({ errors: [cleanupFailure] }),
        });
      } else if (cleanupFails) {
        await expect(command).rejects.toMatchObject({ errors: [cleanupFailure] });
      } else if (outcome === "success") {
        await expect(command).resolves.toBe("done");
      } else {
        await expect(command).rejects.toBe(failure);
      }
      expect(acquired?.runtime.activeLeases).toBe(0);
      expect(() => host?.assertOpen()).toThrow("Plugin SDK resource host is closed");
    } finally {
      releasing.finish();
      await command.catch(() => undefined);
      acquired?.releaseLease();
      await host?.close().catch(() => undefined);
    }
  },
);

it("rejects borrowed commands before preparation after scheduler retirement", async () => {
  const { host, scheduler } = createHost();
  const run = vi.fn(async () => "done");
  mocks.resolveDeps.mockClear();
  mocks.prepare.mockClear();
  mocks.prepare.mockResolvedValue(createPrepared(false));
  try {
    await scheduler.stop();
    await expect(host.run(() => runCommand(run))).rejects.toBe(scheduler.signal.reason);
    expect(mocks.resolveDeps).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(() => host.assertOpen()).not.toThrow();
  } finally {
    mocks.prepare.mockReset();
    await host.close();
    await scheduler.stop();
  }
});

it("borrows the enclosing host without closing its resources or scheduler", async () => {
  const { host, scheduler } = createHost();
  let acquired: SessionMcpRuntimeLease | undefined;
  const maintenance = vi.fn();
  mocks.prepare.mockResolvedValueOnce(createPrepared(false));
  try {
    await host.run(() =>
      runCommand(async () => {
        const currentHost = boundHost();
        const lease = await acquireMcp("borrowed-mcp");
        acquired = lease;
        currentHost.adopt(lease.runtime, { release: () => releaseSessionMcpRuntime(lease) });
        currentHost.scheduler.schedule({
          id: "borrowed-maintenance",
          delayMs: 10,
          run: maintenance,
        });
      }),
    );
    expect(() => host.assertOpen()).not.toThrow();
    expect(acquired?.runtime.activeLeases).toBe(1);
    await clock.advanceBy(10);
    expect(maintenance).toHaveBeenCalledOnce();
    await host.close();
    expect(acquired?.runtime.activeLeases).toBe(0);
  } finally {
    acquired?.releaseLease();
    await scheduler.stop();
    await host.close();
  }
});
it("admits only local operator owners and revokes their authority at settlement", async () => {
  for (const testCase of [
    { operatorAuthority: true, senderIsOwner: true },
    { operatorAuthority: true, senderIsOwner: false },
    { operatorAuthority: false, senderIsOwner: true },
  ]) {
    const admitted = testCase.operatorAuthority && testCase.senderIsOwner;
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    let capability: CronCreatorAuthorityCapability | undefined;
    mocks.prepare.mockResolvedValueOnce(createPrepared(testCase.senderIsOwner));
    await runCommand(
      async (prepared) => {
        capability = prepared.opts.cronCreatorAuthorityCapability;
        retained = bindActiveOperatorTurnAuthority(prepared.runId);
        if (admitted) {
          expect(capability?.callerOrigin).toEqual({ kind: "local" });
          expect(retained?.source).toBe("local");
        } else {
          expect(capability).toBeUndefined();
          expect(retained).toBeUndefined();
        }
      },
      { operatorAuthority: testCase.operatorAuthority },
    );
    if (admitted) {
      expect(() => retained?.assertActive()).toThrow();
      expect(capability?.active).toBe(false);
    }
  }
});

it("keeps runtime memory registrations through local command preparation", async () => {
  const registry = createEmptyPluginRegistry();
  const pluginId = "memory-fixture";
  registry.plugins.push(createPluginRecord({ id: pluginId }));
  const supplement = { search: async () => [], get: async () => null };
  const prepare = async () => ["prepared memory"];
  const builder = () => ["memory guidance"];
  registry.memoryCorpusSupplements.push({ pluginId, supplement });
  registry.memoryPromptPreparations.push({ pluginId, prepare });
  registry.memoryPromptSupplements.push({ pluginId, builder });
  setActivePluginRegistry(registry, undefined, "default", state.workspaceDir);
  mocks.prepare.mockResolvedValueOnce({
    ...createPrepared(false),
    cfg: { plugins: { entries: { [pluginId]: { enabled: true } } } },
  });
  await runCommand(
    async () => {
      const captured = getPluginRuntimeGenerationRegistry();
      expect(captured?.memoryCorpusSupplements).toContainEqual({ pluginId, supplement });
      expect(captured?.memoryPromptPreparations).toContainEqual({ pluginId, prepare });
      expect(captured?.memoryPromptSupplements).toContainEqual({ pluginId, builder });
    },
    { opts: { message: "test", runId: "local-memory" } },
  );
});
it.each([
  { inventory: "empty", contextTokens: 1_000_000, thinking: "medium" },
  { inventory: "authored", contextTokens: 640_000, thinking: "off" },
  { inventory: "replace", contextTokens: 320_000, thinking: "off" },
  { inventory: "generic", contextTokens: 200_000, thinking: "off" },
  { inventory: "explicit off", contextTokens: 1_000_000, thinking: "off" },
] as const)(
  "uses prepared $inventory capabilities on the first request",
  async ({ inventory, contextTokens, thinking }) => {
    const key = "synthetic-static-capability-key";
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, "openclaw.json");
        const stateDir = path.join(home, "state");
        const requests: Array<{ method?: string; url?: string; auth?: string; model: string }> = [];
        const server = http.createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests.push({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization,
            model: body.model,
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const [delta, finish_reason, usage] of [
            [{ role: "assistant", content: "STATIC_OK" }, null, undefined],
            [{}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }],
          ]) {
            const row = {
              id: "fixture-reply",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
              usage,
            };
            res.write(`data: ${JSON.stringify(row)}\n\n`);
          }
          res.end("data: [DONE]\n\n");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected a TCP fixture address");
          }
          const baseUrl = `http://127.0.0.1:${address.port}/proxy/v1`;
          const provider = inventory === "generic" ? "proxy-fixture" : "litellm";
          const model = inventory === "generic" ? "plain-fixture" : "claude-opus-4-6";
          const workspace = path.join(home, "workspace");
          const models =
            inventory === "authored" || inventory === "replace"
              ? [
                  {
                    id: model,
                    name: "Authored fixture",
                    reasoning: false,
                    input: ["text", "image"],
                    contextWindow: contextTokens,
                    maxTokens: 128_000,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ]
              : [];
          const config = {
            agents: {
              defaults: {
                workspace,
                models: { "litellm/claude-opus-4-6": { alias: "LiteLLM" } },
                model: { primary: `${provider}/${model}` },
              },
              entries: {
                main: {
                  name: "main",
                  workspace,
                  agentDir: path.join(stateDir, "agents", "main", "agent"),
                },
              },
            },
            plugins: { entries: { litellm: { enabled: true } } },
            models: {
              mode: inventory === "replace" ? "replace" : "merge",
              providers: {
                [provider]: { baseUrl, api: "openai-completions", apiKey: key, models },
              },
            },
          };
          await fs.writeFile(configPath, JSON.stringify(config));
          expect(requests).toEqual([]);
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              path.resolve("openclaw.mjs"),
              "agent",
              "--local",
              "--agent",
              "main",
              "--message",
              "Reply with STATIC_OK only.",
              "--json",
              ...(inventory === "explicit off" ? ["--thinking", "off"] : []),
            ],
            {
              cwd: process.cwd(),
              env: {
                PATH: process.env.PATH,
                HOME: home,
                USERPROFILE: home,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_CONFIG_PATH: configPath,
                OPENCLAW_NO_RESPAWN: "1",
              },
              timeout: 60_000,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          const output = JSON.parse(stdout);
          expect(output.payloads).toEqual([{ text: "STATIC_OK", mediaUrl: null }]);
          expect(output.meta).toMatchObject({
            agentMeta: { contextTokens },
            requestShaping: { thinking },
          });
          expect(requests).toEqual([
            {
              method: "POST",
              url: "/proxy/v1/chat/completions",
              auth: `Bearer ${key}`,
              model,
            },
          ]);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      { prefix: "openclaw-static-first-request-" },
    );
  },
);
