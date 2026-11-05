import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "./agent-bundle-mcp-manager.test-support.js";
import { ensureAuthProfileStoreAsync } from "./auth-profiles/store-runtime.js";
import { catalogProvider } from "./clawrouter-catalog.test-support.js";
import { providerResponse } from "./embedded-agent-runner.wire.test-support.js";
import { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
import { resolveInlineProviderApiKeyCooldownUntil } from "./model-auth-provider-config.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "./model-selection-config.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  vi.restoreAllMocks();
});

it.each([
  [
    "upstream credits",
    400,
    "invalid_request_error",
    "Your credit balance is too low to access the Anthropic API.",
    false,
  ],
  ["router budget", 402, "budget_exhausted", "proxy key budget is exhausted", true],
  ["router authentication", 401, "invalid_api_key", "Invalid API key", true],
] as const)(
  "scopes %s failures to their owner across sessions",
  async (_label, status, code, message, disabled) => {
    await withOpenClawTestState(
      {
        label: "clawrouter-failover",
        env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined },
      },
      async (state) => {
        installPrivateUpdateHandoffStore(state.root);
        const requests: string[] = [];
        const authorizations: Array<string | undefined> = [];
        let reject = true;
        const server = await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            createServer((request, reply) => {
              request.resume();
              if (request.url === "/v1/catalog") {
                reply.setHeader("content-type", "application/json");
                reply.end(
                  JSON.stringify({
                    providers: [
                      catalogProvider("anthropic", ["claude-fixture"], "llm.messages"),
                      catalogProvider("openai", ["gpt-fixture"], "llm.chat"),
                    ],
                  }),
                );
                return;
              }
              requests.push(request.url ?? "");
              authorizations.push(request.headers.authorization);
              const primary = request.url?.endsWith("/messages");
              if (reject && (disabled || primary)) {
                reply.writeHead(status, { "content-type": "application/json" });
                reply.end(JSON.stringify({ type: "error", error: { type: code, code, message } }));
                return;
              }
              const response = providerResponse({
                api: primary ? "anthropic-messages" : "openai-completions",
                model: primary ? "claude-fixture" : "gpt-fixture",
                id: "synthetic-response",
                messageId: "synthetic-message",
                text: "Peer answered",
                calls: [],
              }).response;
              reply.writeHead(200, { "content-type": "text/event-stream" });
              void response.text().then((body) => reply.end(body));
            }),
        });
        try {
          const model = "clawrouter/anthropic/claude-fixture";
          const fallback = "clawrouter/openai/gpt-fixture";
          const cfg: OpenClawConfig = {
            agents: {
              entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
              defaults: {
                skipBootstrap: true,
                model: { primary: model, fallbacks: [fallback] },
                models: {
                  [model]: { agentRuntime: { id: "openclaw" } },
                  [fallback]: { agentRuntime: { id: "openclaw" } },
                },
              },
            },
            models: {
              providers: {
                clawrouter: {
                  baseUrl: `http://127.0.0.1:${server.claim.port}/v1`,
                  apiKey: "synthetic-router-key",
                  agentRuntime: { id: "openclaw" },
                  api: "anthropic-messages",
                  models: [
                    { id: "anthropic/claude-fixture", api: "anthropic-messages" as const },
                    { id: "openai/gpt-fixture", api: "openai-completions" as const },
                  ].map(({ id, api }) => ({
                    id,
                    api,
                    name: id,
                    reasoning: false,
                    input: ["text" as const],
                    contextWindow: 128_000,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  })),
                },
              },
            },
            plugins: { allow: ["clawrouter"], slots: { memory: "none" } },
            skills: { load: { watch: false } },
            tools: { deny: ["*"] },
          };
          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg);
          const admittedRun = wrapRunWithTestPreparedAdmission(runEmbeddedAgent);
          const run = (id: string, pinned = false) =>
            runWithModelFallback({
              cfg,
              agentDir: state.agentDir(),
              provider: "clawrouter",
              model: "anthropic/claude-fixture",
              fallbacksOverride: modelFallbackOverrideFromAvailability(
                resolveModelFallbackAvailability({
                  cfg,
                  agentId: "main",
                  hasSessionModelOverride: pinned,
                  modelSelectionLocked: pinned,
                }),
              ),
              run: (provider, selectedModel) =>
                admittedRun({
                  config: cfg,
                  agentId: "main",
                  agentDir: state.agentDir(),
                  workspaceDir: state.workspaceDir,
                  runId: id,
                  sessionId: `session-${id}`,
                  sessionKey: `agent:main:${id}`,
                  prompt: "Reply.",
                  provider,
                  model: selectedModel,
                  timeoutMs: 30_000,
                }),
            }).then(({ result }) => result);
          const first = await run("rejected").catch((error: unknown) => error);
          expect(requests.length, String(first)).toBeGreaterThan(0);
          expect(authorizations).toEqual(requests.map(() => "Bearer synthetic-router-key"));
          const firstRequestCount = requests.length;
          const cooldown = resolveInlineProviderApiKeyCooldownUntil(
            await ensureAuthProfileStoreAsync(state.agentDir(), { syncExternalCli: false }),
            "clawrouter",
          );
          expect(Boolean(cooldown && cooldown > Date.now())).toBe(disabled);
          if (disabled) {
            expect(first).toBeInstanceOf(Error);
            expect(firstRequestCount).toBe(1);
          } else {
            expect(first).toMatchObject({ payloads: [{ text: "Peer answered" }] });
            expect(firstRequestCount).toBe(2);
            expect(requests[0]).toMatch(/\/messages$/);
            expect(requests[1]).toMatch(/\/chat\/completions$/);
            const pinned = await run("pinned", true).catch((error: unknown) => error);
            expect(String(pinned)).toMatch(/cannot serve this model.*Choose another model/);
            expect(pinned).toMatchObject({ reason: "route_unavailable" });
            expect(requests.length).toBe(3);
          }
          reject = false;
          const peer = await run("peer").catch((error: unknown) => error);
          expect(requests.length).toBe(firstRequestCount + (disabled ? 0 : 2));
          if (disabled) {
            expect(String(peer)).toMatch(/Retry after|temporarily disabled/);
          } else {
            expect(peer).toMatchObject({ payloads: [{ text: "Peer answered" }] });
          }
        } finally {
          server.listener.closeAllConnections();
          await server.releaseListener();
          await server.claim.release();
        }
      },
    );
  },
);
