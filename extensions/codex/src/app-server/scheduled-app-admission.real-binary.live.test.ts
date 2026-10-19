import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as AttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { isJsonObject } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createIsolatedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { createCodexTestOAuthProfile } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// Opt-in native proof: all credentials and backends are synthetic. Managed
// policy rejection is a failed prerequisite, never successful boundary proof.
const nativeTest =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_SCHEDULED_APP_SYNTHETIC === "1"
    ? it
    : it.skip;
const dirs = useSessionStoreTempDirs(afterEach, "openclaw-scheduled-native-synthetic-");
const APP = "calendar";
const TOOL = "calendar_list_events";
const PROFILE = "openai:secretless-proof";
afterEach(() => {
  setManagedCodexPluginRoot(undefined);
  vi.unstubAllEnvs();
});

nativeTest(
  "scheduled native admitted app reaches loopback effect and rejects foreign/revoked authority",
  async () => {
    const root = dirs.make();
    const proofDir = process.env.OPENCLAW_NATIVE_PROOF_DIR ?? path.join(root, "proof");
    await fs.mkdir(proofDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setManagedCodexPluginRoot(path.resolve(import.meta.dirname, "../.."));
    const methods: string[] = [];
    const effects: unknown[] = [];
    let responses = 0;
    const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url ?? "";
      methods.push(`${req.method} ${url}${body.method ? ` ${body.method}` : ""}`);
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.includes("/responses")) {
        responses++;
        await fs.writeFile(
          path.join(proofDir, "model-tools.json"),
          JSON.stringify(body.tools, null, 2),
        );
        const id = `synthetic-response-${responses}`;
        const events: unknown[] = [{ type: "response.created", response: { id } }];
        if (responses === 1) {
          events.push({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "calendar-proof-call",
              namespace: "mcp__codex_apps__calendar",
              name: "_list_events",
              arguments: "{}",
            },
          });
        }
        events.push({
          type: "response.completed",
          response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      if (url.includes("/api/codex/ps/mcp")) {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        let result: unknown;
        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "secretless-apps", version: "1" },
            };
            break;
          case "notifications/initialized":
            res.writeHead(202);
            res.end();
            return;
          case "tools/list":
            result = {
              tools: [
                {
                  name: TOOL,
                  description: "Read synthetic calendar event",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                  _meta: {
                    connector_id: APP,
                    connector_name: "Calendar",
                    connector_description: "Synthetic calendar",
                    _codex_apps: { connector_id: APP, contains_mcp_source: true },
                  },
                },
              ],
            };
            break;
          case "tools/call":
            effects.push(body.params);
            result = {
              content: [{ type: "text", text: "SECRETLESS_NATIVE_EFFECT_OK" }],
              isError: false,
            };
            break;
          default:
            result = {};
        }
        json({ jsonrpc: "2.0", id: body.id, result });
        return;
      }
      if (url === "/ps/apps/batch") {
        json({
          apps: [
            {
              id: APP,
              name: "Calendar",
              description: "Synthetic calendar",
              tools: [
                {
                  name: TOOL,
                  title: "List events",
                  description: "Read synthetic calendar event",
                  is_enabled: true,
                  is_read_only: true,
                },
              ],
            },
          ],
        });
        return;
      }
      if (url.includes("/connectors/")) {
        json({ apps: [], nextToken: null });
        return;
      }
      json({ error: `Unexpected fixture route ${url}` }, 404);
    };
    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback port");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;
    const receipts: unknown[] = [];
    try {
      for (const scenario of ["foreign-account", "revoked-policy", "allowed"] as const) {
        responses = 0;
        const effectBoundary = effects.length;
        const agentId = `secretless-${scenario}`;
        const agentDir = path.join(root, agentId);
        const workspaceDir = path.join(agentDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const target = {
          agentId,
          sessionId: agentId,
          sessionKey: `agent:${agentId}:main`,
          storePath: path.join(agentDir, "openclaw-agent.sqlite"),
        };
        const profile = {
          ...createCodexTestOAuthProfile(
            scenario === "foreign-account" ? "foreign-account" : "synthetic-account",
          ),
          expires: Date.now() + 86_400_000,
        };
        const params = {
          ...target,
          sessionTarget: target,
          sessionFile: path.join(agentDir, "session.jsonl"),
          workspaceDir,
          cwd: workspaceDir,
          agentDir,
          provider: "openai",
          modelId: "gpt-5.4-codex",
          model: {
            id: "gpt-5.4-codex",
            name: "gpt-5.4-codex",
            provider: "openai",
            api: "openai-chatgpt-responses",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 4000,
            compat: { supportsTools: true },
          },
          prompt: "Read the synthetic calendar once.",
          runId: agentId,
          trigger: "cron",
          oneShotCliRun: true,
          toolsAllow: [],
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          scheduledRuntimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: {
              version: 1,
              auth: { profileId: PROFILE, accountId: "synthetic-account" },
              apps: [
                {
                  id: APP,
                  allowDestructiveActions: false,
                  allowOpenWorld: false,
                  destructiveApprovalMode: "deny",
                  tools: { [TOOL]: "auto" },
                },
              ],
            },
          },
          pluginHarnessToolPolicyRestricted: true,
          contextTokenBudget: 100_000,
          thinkLevel: "low",
          disableTools: false,
          config: { tools: { web: { search: { enabled: false } } } },
          timeoutMs: 60_000,
          authStorage: {},
          modelRegistry: {},
          authProfileId: PROFILE,
          authProfileStore: { version: 1, profiles: { [PROFILE]: profile } },
          runtimePlan: {
            auth: {
              providerForAuth: "openai",
              authProfileProviderForAuth: "openai",
              forwardedAuthProfileId: PROFILE,
              selectedAuthMode: "subscription",
              modelRoute: {
                provider: "openai",
                modelId: "gpt-5.4-codex",
                api: "openai-chatgpt-responses",
                baseUrl: endpoint,
                authRequirement: "subscription",
                requestTransportOverrides: "none",
              },
            },
            observability: {
              resolvedRef: "openai/gpt-5.4-codex",
              provider: "openai",
              modelId: "gpt-5.4-codex",
              harnessId: "codex",
            },
            prompt: { resolveSystemPromptContribution: () => undefined },
            tools: { normalize: (tools: unknown[]) => tools, logDiagnostics: () => undefined },
          },
        } as unknown as AttemptParams;
        await upsertSessionEntry({
          ...target,
          entry: {
            sessionId: target.sessionId,
            sessionFile: params.sessionFile,
            updatedAt: Date.now(),
          },
        });
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: params,
          pluginId: "codex",
          nativeModelPolicySupport: "exact",
        });
        params.hostCapabilities = host.capabilities;
        const clients: CodexAppServerClient[] = [];
        let acquired = 0;
        let turns = 0;
        const factory: CodexAppServerClientFactory = async (options) => {
          acquired++;
          const client = await createIsolatedCodexAppServerClient(options);
          clients.push(client);
          expect(client.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
          const nativeConfig = await client.request("config/read", {
            cwd: workspaceDir,
            includeLayers: false,
          });
          const nativeApps = nativeConfig.config.apps;
          if (!isJsonObject(nativeApps) || !isJsonObject(nativeApps["_default"])) {
            throw new Error("Native app defaults must be present for this regression proof");
          }
          expect(nativeApps[APP]).toBeUndefined();
          expect(nativeApps["_default"].enabled).toBe(false);
          const request = client.request.bind(client);
          client.request = (async (...args: Parameters<CodexAppServerClient["request"]>) => {
            if (args[0] === "turn/start") {
              turns++;
            }
            return request(...args);
          }) as typeof client.request;
          return client;
        };
        const pluginConfig = {
          appServer: {
            homeScope: "agent" as const,
            command: path.resolve(
              import.meta.dirname,
              "../../node_modules/@openai/codex/bin/codex.js",
            ),
            approvalPolicy: "never" as const,
            sandbox: "read-only" as const,
            requestTimeoutMs: 30_000,
            args: [
              "-c",
              'cli_auth_credentials_store="ephemeral"',
              "-c",
              "features.apps=true",
              "-c",
              `chatgpt_base_url="${endpoint}"`,
              "-c",
              'model_provider="mock_provider"',
              "-c",
              `model_providers.mock_provider={name="Secretless mock",base_url="${endpoint}/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
              "-c",
              "apps._default.enabled=false",
              "-c",
              "apps._default.destructive_enabled=false",
              "-c",
              "apps._default.open_world_enabled=false",
              "app-server",
            ],
          },
          codexPlugins: {
            enabled: scenario !== "revoked-policy",
            allow_all_plugins: true,
            allow_destructive_actions: "ask" as const,
          },
        };
        try {
          const pending = runCodexAppServerAttempt(params, {
            bindingStore: createCodexTestBindingStore(),
            pluginConfig,
            clientFactory: factory,
          });
          if (scenario === "foreign-account") {
            await expect(pending).rejects.toThrow("that exact prepared account is not active");
            expect(acquired).toBe(0);
          } else if (scenario === "revoked-policy") {
            await expect(pending).rejects.toThrow("Scheduled Codex apps are unavailable");
          } else {
            expect((await pending).terminal.kind).toBe("ok");
            expect(effects.slice(effectBoundary)).toEqual([
              expect.objectContaining({ name: TOOL }),
            ]);
            expect(turns).toBe(1);
          }
          if (scenario !== "allowed") {
            expect(turns).toBe(0);
            expect(effects.length).toBe(effectBoundary);
          }
          receipts.push({
            scenario,
            acquired,
            turns,
            effects: effects.length - effectBoundary,
            passed: true,
          });
        } finally {
          host.close();
          for (const client of clients) {
            await client.closeAndWait();
          }
        }
      }
    } finally {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "receipts.json"),
        JSON.stringify(
          { binaryVersion: CODEX_APP_SERVER_VERSION, receipts, methods, effects },
          null,
          2,
        ),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
  180_000,
);
