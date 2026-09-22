import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBuiltCli } from "../../test/cli-json-stdout.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import {
  bindActiveOperatorTurnAuthority,
  type CronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  resolveDeps: vi.fn(async () => ({})),
}));

vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: mocks.prepare,
}));

vi.mock("./command/runtime-loaders.js", () => ({
  resolveAgentCommandDeps: mocks.resolveDeps,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-command-authority" });
});
afterEach(async () => {
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
  it.each([
    { inventory: "empty", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "authored", contextTokens: 640_000, thinking: "off" },
    { inventory: "replace", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "generic", contextTokens: 200_000, thinking: "off" },
    { inventory: "explicit off", contextTokens: 1_000_000, thinking: "off" },
  ])("uses prepared $inventory capabilities on the first request", async (testCase) => {
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, "openclaw.json");
        const stateDir = path.join(home, "state");
        const key = "synthetic-static-capability-key";
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
          if (testCase.inventory === "replace") {
            await fs.writeFile(configPath, JSON.stringify({ models: { mode: "replace" } }));
          }
          const onboard = runBuiltCli(
            home,
            [
              "onboard",
              "--non-interactive",
              "--accept-risk",
              "--skip-health",
              "--auth-choice",
              "litellm-api-key",
              "--litellm-api-key",
              key,
              "--custom-base-url",
              baseUrl,
              "--workspace",
              path.join(home, "workspace"),
              "--skip-channels",
              "--skip-skills",
              "--skip-ui",
              "--no-install-daemon",
            ],
            env,
            { inheritEnvironment: false },
          );
          expect(onboard.status, onboard.stderr).toBe(0);
          const config = JSON.parse(await fs.readFile(configPath, "utf8"));
          if (testCase.inventory === "authored") {
            config.models.providers.litellm.models = [
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
            expect(config.models.providers.litellm.models).toHaveLength(1);
          } else if (testCase.inventory === "generic") {
            config.models.providers = {
              "proxy-fixture": { baseUrl, api: "openai-completions", apiKey: key, models: [] },
            };
            config.agents.defaults.model.primary = "proxy-fixture/plain-fixture";
          } else {
            config.models.providers.litellm.models = [];
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
          const primary = config.agents.defaults.model.primary;
          expect(requests).toEqual([
            {
              method: "POST",
              url: "/proxy/v1/chat/completions",
              auth: `Bearer ${key}`,
              model: primary.slice(primary.indexOf("/") + 1),
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
