import { request } from "node:http";
import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codexModel, threadStartResult } from "./bounded-turn.test-harness.js";
import { turnStartResult } from "./codex-app-server.test-fixtures.js";
import {
  createCodexBoundedInferenceModelBinding,
  CodexInferenceAuthorizationError,
  type CodexInferenceModelRequest,
} from "./inference-dispatch.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { isolatedParams, type IsolatedParams } from "./isolated-completion.params-test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { createClientHarness, stubCodexInferenceTransportEnv } from "./test-support.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), bodies: [] as unknown[] }));
// Only provider HTTP is replaced. The completion, auth handoff, app-server
// protocol, ephemeral thread and authenticated loopback relay are real owners.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: transport.fetch };
});

beforeEach(() => {
  stubCodexInferenceTransportEnv();
  transport.bodies = [];
  transport.fetch.mockReset().mockImplementation(async (params) => {
    params.beforeRequest();
    transport.bodies.push(JSON.parse(await new Response(params.init.body).text()));
    return {
      response: new Response('data: {"type":"response.completed"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      release: async () => {},
    };
  });
});
afterEach(() => vi.unstubAllEnvs());

const profileId = "openai:research-fixture";
function siwcStore(flow = "chatgpt-token-sharing"): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai",
        authFlow: flow,
        access: "synthetic-plan-access",
        refresh: "synthetic-plan-refresh",
        expires: 4_102_444_800_000,
        issuer: "https://auth.openai.com",
        clientId: "synthetic-client",
        idToken: `header.${Buffer.from(JSON.stringify({ sub: "selected-subject" })).toString("base64url")}.signature`,
      },
    },
  };
}
async function post(url: string, body: JsonObject, key: string) {
  if (new URL(url).hostname !== "127.0.0.1") {
    throw new Error("Loopback fixture only");
  }
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", agent: false, headers: { authorization: `Bearer ${key}` } },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

it.each(["api-key", "siwc"] as const)(
  "preserves %s identity and the selected Responses endpoint through native bounded dispatch",
  async (mode) => {
    const endpoint =
      mode === "api-key" ? "https://selected-api.example/v1" : "https://api.openai.com/v1";
    const calls: Array<{ method: string; params?: JsonObject }> = [];
    let privateHome = "";
    let nativeKey = "";
    let threadConfig: JsonObject = {};
    const refresh = vi.fn(async () => ({
      token: "synthetic-plan-access",
      assertCurrent: () => {},
    }));
    const h = createClientHarness({
      onWrite(line, send) {
        const rpc = JSON.parse(line) as { id?: number; method: string; params?: JsonObject };
        calls.push(rpc);
        if (rpc.id === undefined) {
          return;
        }
        const respond = (result: unknown) => send({ id: rpc.id, result });
        if (rpc.method === "config/read") {
          return respond({
            config: {
              mcp_servers: {},
              features: { hooks: true, plugins: false },
              project_root_markers: [],
            },
            layers: [
              { name: { type: "user", file: path.join(privateHome, "config.toml") }, config: {} },
            ],
          });
        }
        if (rpc.method === "hooks/list") {
          return respond({
            data: [
              {
                cwd: (rpc.params?.cwds as string[] | undefined)?.[0],
                hooks: [],
                errors: [],
                warnings: [],
              },
            ],
          });
        }
        if (rpc.method === "account/read") {
          return respond({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
        }
        if (rpc.method === "model/list") {
          return respond({ data: [codexModel()], nextCursor: null });
        }
        if (rpc.method === "configRequirements/read") {
          return respond({ requirements: null });
        }
        if (rpc.method === "mcpServerStatus/list") {
          return respond({ data: [], nextCursor: null });
        }
        if (rpc.method === "thread/start") {
          threadConfig = rpc.params?.config as JsonObject;
          expect(rpc.params).toMatchObject({
            ephemeral: true,
            environments: [],
            dynamicTools: [],
            baseInstructions: "",
          });
          const modelProvider = rpc.params?.modelProvider;
          if (typeof modelProvider !== "string") {
            throw new Error("Missing model provider");
          }
          return respond(threadStartResult("gpt-5.4", modelProvider));
        }
        if (rpc.method === "turn/start") {
          respond(turnStartResult("turn-native"));
          const providers = threadConfig.model_providers;
          const sharing = isJsonObject(providers) ? providers.openclaw_token_sharing : undefined;
          const base = isJsonObject(sharing) ? sharing.base_url : threadConfig.openai_base_url;
          if (typeof base !== "string") {
            throw new Error("Missing prepared endpoint");
          }
          const body = {
            model: "gpt-5.4",
            input: [{ role: "user", content: "A bounded question" }],
            stream: true,
            store: false,
            tools: [],
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: "thread-finalizer",
                turn_id: "turn-native",
                request_kind: "turn",
                ...(rpc.params?.responsesapiClientMetadata as JsonObject),
              }),
            },
          };
          void post(base + "/responses", { ...body, model: "unselected-model" }, nativeKey)
            .then((status) => {
              expect(status).toBe(403);
              return post(base + "/responses", body, nativeKey);
            })
            .then((status) =>
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-finalizer",
                  turn: {
                    ...turnStartResult("turn-native", status === 200 ? "completed" : "failed").turn,
                    items: [{ id: "answer", type: "agentMessage", text: "Bounded native answer" }],
                  },
                },
              }),
            );
          return;
        }
        send({ id: rpc.id, error: { code: -32601, message: rpc.method } });
      },
    });
    const params = isolatedParams(siwcStore(), profileId);
    if (params.authorization.owner !== "harness") {
      throw new Error("fixture");
    }
    params.authorization.plan.modelRoute!.authRequirement = "api-key";
    params.authorization.plan.modelRoute!.api = "openai-responses";
    params.authorization.plan.modelRoute!.baseUrl = "https://api.openai.com/v1";
    params.authorization.plan.selectedAuthMode = "oauth";
    params.authorization.plan.selectedAuthFlow = "chatgpt-token-sharing";
    if (mode === "api-key") {
      params.authorization = {
        owner: "host",
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-responses",
          baseUrl: endpoint,
        } as Extract<IsolatedParams["authorization"], { owner: "host" }>["model"],
        auth: { mode: "api-key", apiKey: "synthetic-selected-key", profileId, source: "profile" },
      };
    }
    try {
      const result = await runCodexIsolatedCompletion(params, {
        clientFactory: async (options) => {
          privateHome = options?.startOptions?.env?.CODEX_HOME ?? "";
          expect(privateHome).toContain("codex-bounded-turn-");
          const prepared = options?.preparedAuth;
          if (prepared?.kind === "api-key") {
            nativeKey = prepared.apiKey;
          } else if (
            prepared?.kind === "profile" &&
            prepared.snapshot?.loginParams.type === "apiKey"
          ) {
            expect(prepared.profileId).toBe(profileId);
            nativeKey = prepared.snapshot.loginParams.apiKey;
            expect(nativeKey).not.toBe("synthetic-plan-access");
          } else {
            throw new Error("Missing prepared account");
          }
          ownCodexInferenceClient(h.client, {}, mode === "siwc" ? { resolve: refresh } : undefined);
          return h.client;
        },
      });
      expect(result.assistant).toMatchObject({
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Bounded native answer" }],
      });
      expect(transport.fetch).toHaveBeenCalledOnce();
      const outgoing = transport.fetch.mock.calls[0]![0];
      expect(outgoing.url).toBe(`${endpoint}/responses`);
      expect(outgoing.init.headers.authorization).toBe(
        `Bearer ${mode === "siwc" ? "synthetic-plan-access" : "synthetic-selected-key"}`,
      );
      const body = transport.bodies[0];
      expect(body).toMatchObject({
        model: "gpt-5.4",
        stream: true,
        store: false,
        tool_choice: "none",
      });
      expect(body).not.toHaveProperty("previous_response_id");
      expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(refresh).toHaveBeenCalledTimes(mode === "siwc" ? 1 : 0);
    } finally {
      await h.client.closeAndWait();
    }
  },
);

it("rejects identity-only SIWC before starting a native client", async () => {
  const params = isolatedParams(siwcStore("chatgpt-identity"), profileId);
  if (params.authorization.owner !== "harness") {
    throw new Error("fixture");
  }
  params.authorization.plan.modelRoute!.authRequirement = "api-key";
  params.authorization.plan.modelRoute!.api = "openai-responses";
  params.authorization.plan.modelRoute!.baseUrl = "https://api.openai.com/v1";
  const clientFactory = vi.fn();
  await expect(runCodexIsolatedCompletion(params, { clientFactory })).rejects.toThrow();
  expect(clientFactory).not.toHaveBeenCalled();
});

it.each([
  { path: "/responses/compact" },
  { body: { model: "unselected-model" } },
  { metadata: { requestKind: "prewarm" } },
  { metadata: { requestKind: "turn", parentThreadId: "parent" } },
  { metadata: { requestKind: "turn", subagent: "child" } },
  { metadata: { requestKind: "turn", subagentKind: "review" } },
])("rejects unauthorized bounded native inference %j", (overrides) => {
  const bind = createCodexBoundedInferenceModelBinding({
    model: "gpt-5.4",
    assertCurrent: () => {},
  });
  expect(() => bind(boundedRequest(overrides))).toThrow(CodexInferenceAuthorizationError);
});

it("rechecks retained caller authority and rejects aborted bounded inference", () => {
  let current = true;
  const retired = new Error("caller authority retired");
  const bind = createCodexBoundedInferenceModelBinding({
    model: "gpt-5.4",
    assertCurrent: () => {
      if (!current) {
        throw retired;
      }
    },
  });
  const execution = bind(boundedRequest());
  current = false;
  expect(() => execution.assertCurrent()).toThrow(retired);
  expect(() => bind(boundedRequest())).toThrow(retired);
  current = true;
  const aborted = new Error("request aborted");
  expect(() => bind(boundedRequest({ signal: AbortSignal.abort(aborted) }))).toThrow(aborted);
});

function boundedRequest(
  overrides: Partial<CodexInferenceModelRequest> = {},
): CodexInferenceModelRequest {
  return {
    path: "/responses",
    body: { model: "gpt-5.4" },
    metadata: { requestKind: "turn" },
    headers: {},
    transport: "http",
    signal: new AbortController().signal,
    ...overrides,
  };
}
