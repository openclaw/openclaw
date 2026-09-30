import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  releaseSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
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
  const lease = await acquireSessionMcpRuntime({
    sessionId,
    workspaceDir: state.workspaceDir,
    cfg: unopenedMcpConfig,
  });
  try {
    expect((await lease.runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
      "probe",
    ]);
    await expect(lease.runtime.callTool("fixture", "probe", {})).resolves.toMatchObject({
      content: [{ type: "text", text }],
    });
    return lease.runtime;
  } finally {
    await releaseSessionMcpRuntime(lease);
  }
}

describe("runLocalAgentCommand MCP transport settlement", () => {
  it.each([
    { name: "owned success", borrowed: false, cleanup: false, preparationFailure: false },
    {
      name: "owned revoked preparation",
      borrowed: false,
      cleanup: false,
      preparationFailure: true,
    },
    { name: "borrowed retained", borrowed: true, cleanup: false, preparationFailure: false },
    { name: "borrowed cleanup", borrowed: true, cleanup: true, preparationFailure: false },
  ])("settles $name without retiring another session", async (scenario) => {
    const survivor = await createMcpPeer("survivor");
    const commandPeer = await createMcpPeer("command");
    const survivorClock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(survivorClock.clock);
    const host = new LegacyPluginSdkResourceHost();
    host.bindScheduler(scheduler);
    const closeStarted = createDeferred();
    const finishClose = createDeferred();
    const closeTransport = commandPeer.transport.close.bind(commandPeer.transport);
    vi.spyOn(commandPeer.transport, "close").mockImplementationOnce(async () => {
      closeStarted.resolve();
      await finishClose.promise;
      await closeTransport();
    });
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
        runLocalAgentCommand({
          opts: { message: "test", runId: "run-local", cleanupBundleMcpOnRunEnd: scenario.cleanup },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          run: async (prepared) => {
            const context = buildPreparedCliRunContext({
              sessionId: "command-mcp",
              runId: prepared.runId,
              workspaceDir: state.workspaceDir,
            });
            context.params.cleanupBundleMcpOnRunEnd = prepared.opts.cleanupBundleMcpOnRunEnd;
            if (scenario.preparationFailure) {
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
        }).finally(() => {
          settled = true;
        });
      command = scenario.borrowed ? host.run(run) : run();
      void command.catch(() => undefined);
      const retires = !scenario.borrowed || scenario.cleanup;
      if (retires) {
        await Promise.race([closeStarted.promise, command.catch(() => undefined)]);
        expect(settled).toBe(false);
        finishClose.resolve();
      }
      if (scenario.preparationFailure) {
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
        await expect(
          peekSessionMcpRuntime({ sessionId: "command-mcp" })?.callTool("fixture", "probe", {}),
        ).resolves.toMatchObject({ content: [{ type: "text", text: "command" }] });
      }
      await expect(retained.callTool("fixture", "probe", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "survivor" }],
      });
      await survivorClock.advanceBy(10);
      expect(maintenance).toHaveBeenCalledOnce();
    } finally {
      finishClose.resolve();
      await command?.catch(() => undefined);
      await disposeAllSessionMcpRuntimes();
      await scheduler.stop();
      await host.close();
      await Promise.all([survivor.server.close(), commandPeer.server.close()]);
    }
  });
});

describe("runLocalAgentCommand resource lifetime", () => {
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
      const releaseStarted = createDeferred();
      const finishRelease = createDeferred();
      const failure = new Error(outcome);
      const cleanupFailure = new Error("resource release failed");
      const maintenance = vi.fn();
      let host: LegacyPluginSdkResourceHost | undefined;
      let acquired: SessionMcpRuntimeLease | undefined;
      mocks.prepare.mockImplementationOnce(async () => {
        const currentHost = getBoundLegacyPluginSdkResourceHost();
        if (!currentHost) {
          throw new Error("Local command did not bind its resource host");
        }
        const lease = await acquireSessionMcpRuntime({
          sessionId: "local-mcp",
          workspaceDir: state.workspaceDir,
          cfg: unopenedMcpConfig,
        });
        host = currentHost;
        acquired = lease;
        host.adopt(lease.runtime, {
          release: async () => {
            releaseStarted.resolve();
            await finishRelease.promise;
            await releaseSessionMcpRuntime(lease);
            if (cleanupFails) {
              throw cleanupFailure;
            }
          },
        });
        host.scheduler.schedule({ id: "local-maintenance", delayMs: 10, run: maintenance });
        if (outcome === "preparation failure") {
          throw failure;
        }
        return createPrepared(false);
      });
      let settled = false;
      const command = runLocalAgentCommand({
        opts: { message: "test", runId: "run-local" },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        run: async () => {
          if (outcome === "execution failure") {
            throw failure;
          }
          return "done";
        },
      }).finally(() => {
        settled = true;
      });
      void command.catch(() => undefined);
      try {
        await Promise.race([releaseStarted.promise, command]);
        expect(settled).toBe(false);
        expect(acquired?.runtime.activeLeases).toBe(1);
        expect(clock.armedAtMs).toBeNull();
        await clock.advanceBy(10);
        expect(maintenance).not.toHaveBeenCalled();

        finishRelease.resolve();
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
        finishRelease.resolve();
        await command.catch(() => undefined);
        acquired?.releaseLease();
        await host?.close().catch(() => undefined);
      }
    },
  );

  it("rejects borrowed commands before preparation after scheduler retirement", async () => {
    const scheduler = createTestGatewayScheduler(clock.clock);
    const host = new LegacyPluginSdkResourceHost();
    host.bindScheduler(scheduler);
    const run = vi.fn(async () => "done");
    mocks.resolveDeps.mockClear();
    mocks.prepare.mockClear();
    mocks.prepare.mockResolvedValue(createPrepared(false));
    try {
      await scheduler.stop();
      await expect(
        host.run(() =>
          runLocalAgentCommand({
            opts: { message: "test", runId: "run-local" },
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            run,
          }),
        ),
      ).rejects.toBe(scheduler.signal.reason);
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
    const scheduler = createTestGatewayScheduler(clock.clock);
    const host = new LegacyPluginSdkResourceHost();
    host.bindScheduler(scheduler);
    let acquired: SessionMcpRuntimeLease | undefined;
    const maintenance = vi.fn();
    mocks.prepare.mockResolvedValueOnce(createPrepared(false));
    try {
      await host.run(() =>
        runLocalAgentCommand({
          opts: { message: "test", runId: "run-local" },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          run: async () => {
            const currentHost = getBoundLegacyPluginSdkResourceHost();
            if (!currentHost) {
              throw new Error("Local command lost its enclosing resource host");
            }
            const lease = await acquireSessionMcpRuntime({
              sessionId: "borrowed-mcp",
              workspaceDir: state.workspaceDir,
              cfg: unopenedMcpConfig,
            });
            acquired = lease;
            currentHost.adopt(lease.runtime, { release: () => releaseSessionMcpRuntime(lease) });
            currentHost.scheduler.schedule({
              id: "borrowed-maintenance",
              delayMs: 10,
              run: maintenance,
            });
          },
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
});

describe("runLocalAgentCommand operator authority", () => {
  it("binds local authority to the exact admitted operator run and revokes it at settlement", async () => {
    mocks.prepare.mockResolvedValueOnce(createPrepared(true));
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    let capability: CronCreatorAuthorityCapability | undefined;

    await runLocalAgentCommand({
      opts: { message: "test", runId: "run-local" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      operatorAuthority: true,
      run: async (prepared) => {
        capability = prepared.opts.cronCreatorAuthorityCapability;
        retained = bindActiveOperatorTurnAuthority(prepared.runId);
        expect(capability?.callerOrigin).toEqual({ kind: "local" });
        expect(retained?.source).toBe("local");
      },
    });

    expect(() => retained?.assertActive()).toThrow();
    expect(capability?.active).toBe(false);
  });

  it("does not mint local authority for a non-owner or system run", async () => {
    for (const testCase of [
      { operatorAuthority: true, senderIsOwner: false },
      { operatorAuthority: false, senderIsOwner: true },
    ]) {
      mocks.prepare.mockResolvedValueOnce(createPrepared(testCase.senderIsOwner));
      await runLocalAgentCommand({
        opts: { message: "test", runId: "run-local" },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        operatorAuthority: testCase.operatorAuthority,
        run: async (prepared) => {
          expect(prepared.opts.cronCreatorAuthorityCapability).toBeUndefined();
          expect(bindActiveOperatorTurnAuthority(prepared.runId)).toBeUndefined();
        },
      });
    }
  });
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
  await runLocalAgentCommand({
    opts: { message: "test", runId: "local-memory" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    run: async () => {
      const captured = getPluginRuntimeGenerationRegistry();
      expect(captured?.memoryCorpusSupplements).toContainEqual({ pluginId, supplement });
      expect(captured?.memoryPromptPreparations).toContainEqual({ pluginId, prepare });
      expect(captured?.memoryPromptSupplements).toContainEqual({ pluginId, builder });
    },
  });
});
describe("agent command static capabilities", () => {
  const cases = [
    { inventory: "empty", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "authored", contextTokens: 640_000, thinking: "off" },
    { inventory: "replace", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "generic", contextTokens: 200_000, thinking: "off" },
    { inventory: "explicit off", contextTokens: 1_000_000, thinking: "off" },
  ] as const;
  const key = "synthetic-static-capability-key";

  it.each(cases)("uses prepared $inventory capabilities on the first request", async (testCase) => {
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, "openclaw.json");
        const stateDir = path.join(home, "state");
        const requests: Array<{ method?: string; url?: string; auth?: string; model: string }> = [];
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests.push({
              method: req.method,
              url: req.url,
              auth: req.headers.authorization,
              model: body.model,
            });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const common = {
              id: "fixture-reply",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
            };
            for (const row of [
              {
                ...common,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "STATIC_OK" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...common,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ]) {
              res.write(`data: ${JSON.stringify(row)}\n\n`);
            }
            res.end("data: [DONE]\n\n");
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected a TCP fixture address");
          }
          const baseUrl = `http://127.0.0.1:${address.port}/proxy/v1`;
          const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
          const primary = "litellm/claude-opus-4-6";
          // LiteLLM onboarding and replace-mode config generation are covered in
          // extensions/litellm/index.test.ts. This integration test needs only the
          // exact config inputs for each isolated first local request.
          const litellmProvider = {
            baseUrl,
            api: "openai-completions",
            apiKey: key,
            models:
              testCase.inventory === "replace"
                ? [
                    {
                      id: "claude-opus-4-6",
                      name: "Claude Opus 4.6",
                      reasoning: true,
                      input: ["text", "image"],
                      contextWindow: 1_000_000,
                      maxTokens: 128_000,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ]
                : ([] as Array<Record<string, unknown>>),
          };
          const providers: Record<string, typeof litellmProvider> = { litellm: litellmProvider };
          const config = {
            agents: {
              defaults: {
                workspace: path.join(home, "workspace"),
                models: { [primary]: { alias: "LiteLLM" } },
                model: { primary },
              },
              entries: {
                main: {
                  name: "main",
                  workspace: path.join(home, "workspace"),
                  agentDir: path.join(stateDir, "agents", "main", "agent"),
                },
              },
            },
            plugins: { entries: { litellm: { enabled: true } } },
            models: {
              mode: testCase.inventory === "replace" ? "replace" : "merge",
              providers,
            },
          };
          if (testCase.inventory === "authored") {
            litellmProvider.models = [
              {
                id: config.agents.defaults.model.primary.slice("litellm/".length),
                name: "Authored fixture",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 640_000,
                maxTokens: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ];
          } else if (testCase.inventory === "replace") {
            expect(litellmProvider.models).toHaveLength(1);
          } else if (testCase.inventory === "generic") {
            config.models.providers = {
              "proxy-fixture": { baseUrl, api: "openai-completions", apiKey: key, models: [] },
            };
            config.agents.defaults.model.primary = "proxy-fixture/plain-fixture";
          } else {
            litellmProvider.models = [];
          }
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
              ...(testCase.inventory === "explicit off" ? ["--thinking", "off"] : []),
            ],
            {
              cwd: process.cwd(),
              env: {
                PATH: process.env.PATH,
                HOME: home,
                USERPROFILE: home,
                ...env,
                OPENCLAW_NO_RESPAWN: "1",
              },
              timeout: 60_000,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          const output = JSON.parse(stdout);
          expect(output.payloads).toEqual([{ text: "STATIC_OK", mediaUrl: null }]);
          expect(output.meta.agentMeta.contextTokens).toBe(testCase.contextTokens);
          expect(output.meta.requestShaping.thinking).toBe(testCase.thinking);
          const selectedPrimary = config.agents.defaults.model.primary;
          expect(requests).toEqual([
            {
              method: "POST",
              url: "/proxy/v1/chat/completions",
              auth: `Bearer ${key}`,
              model: selectedPrimary.slice(selectedPrimary.indexOf("/") + 1),
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
  });
});
