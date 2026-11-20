import { expect, vi } from "vitest";
import { createAnthropicResponse } from "../../packages/ai/src/provider-transport-parity.test-support.js";
import { createSseResponse } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import {
  completedResponse,
  wireMessage,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { stream as streamRaw } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { StreamFn } from "./runtime/index.js";
import { completionChunk } from "./simple-completion.test-support.js";

export const routes = [
  [
    "opencode",
    "minimax-m3",
    "openai-completions",
    "llm.chat",
    "chat_completions",
    "/chat/completions",
    "openai.chat_completions",
  ],
  [
    "opencode-go",
    "deepseek-v4-pro",
    "openai-completions",
    "llm.chat",
    "chat_completions",
    "/chat/completions",
    "openai.chat_completions",
  ],
  [
    "opencode",
    "gpt-5.6-sol",
    "openai-responses",
    "llm.responses",
    "responses",
    "/v1/responses",
    "openai.responses",
  ],
  [
    "opencode-go",
    "gpt-5.6-luna",
    "openai-responses",
    "llm.responses",
    "responses",
    "/v1/responses",
    "openai.responses",
  ],
  [
    "opencode",
    "claude-opus-5",
    "anthropic-messages",
    "llm.messages",
    "messages",
    "/v1/messages",
    "anthropic.messages",
  ],
  [
    "opencode-go",
    "qwen3.8-max",
    "anthropic-messages",
    "llm.messages",
    "messages",
    "/v1/messages",
    "anthropic.messages",
  ],
] as const;
export type Route = readonly [
  (typeof routes)[number][0],
  string,
  (typeof routes)[number][2],
  string,
  string,
  string,
  string,
];

export const rawStream: StreamFn = (model, context, options) =>
  streamRaw(model, context, { ...options });

function reply(route: Route) {
  if (route[2] === "openai-completions") {
    return new Response(completionChunk("ok", route[1]), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (route[2] === "openai-responses") {
    return createSseResponse([
      completedResponse("resp_fixture", [wireMessage("msg_fixture", "ok")]),
    ]);
  }
  return createAnthropicResponse([
    {
      type: "message_start",
      message: { id: "msg_fixture", model: route[1], usage: { input_tokens: 2, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

export async function fixture(
  route: Route,
  run: (value: {
    model: Model;
    plugin: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
    requests: Request[];
    catalogKeys: Array<string | null>;
    expectedUrl: string;
  }) => Promise<void>,
  options: {
    native?: boolean;
    missing?: boolean;
    providerPatch?: Record<string, unknown>;
    offerPatch?: Record<string, unknown>;
    modelPatch?: Record<string, unknown>;
    routePatch?: Record<string, unknown>;
    respond?: (request: Request) => Response | Promise<Response>;
  } = {},
) {
  const [upstreamProvider, upstream, api, capability, endpoint, path, format] = route;
  const id = upstreamProvider + "/" + upstream;
  const native = options.native ?? api === "anthropic-messages";
  const publicPath = native
    ? `/v1/native/${upstreamProvider}${path}`
    : api === "openai-completions"
      ? "/v1/chat/completions"
      : "/v1/responses";
  const requests: Request[] = [],
    catalogKeys: Array<string | null> = [];
  vi.stubEnv("OPENCODE_API_KEY", "synthetic-vendor-must-not-win");
  vi.stubEnv("OPENCODE_GO_API_KEY", "synthetic-go-must-not-win");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-must-not-win");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/v1/catalog")) {
      catalogKeys.push(request.headers.get("authorization"));
      return Response.json({
        version: "clawrouter.client-catalog.v1",
        providers: [
          {
            id: upstreamProvider,
            displayName: upstreamProvider,
            allowed: true,
            executable: true,
            openaiCompatible: true,
            nativeBaseUrl: `/v1/native/${upstreamProvider}`,
            routes: [
              {
                endpoint,
                path,
                methods: ["POST"],
                requestFormat: format,
                responseFormat: format,
                ...options.routePatch,
              },
            ],
            models: [{ id, upstream, capabilities: [capability], ...options.modelPatch }],
            offers: [
              {
                endpoint,
                modelId: id,
                transport: "http",
                routeKind: native ? "native" : "unified",
                route: publicPath,
                eligible: true,
                affordability: "request-dependent",
                ...options.offerPatch,
              },
            ],
            ...options.providerPatch,
          },
        ],
      });
    }
    requests.push(request);
    if (request.headers.get("authorization") !== "Bearer synthetic-router-key") {
      return Response.json(
        { error: { type: "permission_error", message: "Synthetic foreign grant" } },
        { status: 403 },
      );
    }
    return options.respond ? options.respond(request) : reply(route);
  });
  const entry = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry.default);
  await withOpenClawTestState({ label: "clawrouter-opencode-session" }, async (state) => {
    const config = {
      models: {
        providers: {
          clawrouter: {
            apiKey: "synthetic-router-key",
            baseUrl: "https://clawrouter.openclaw.ai/tenant/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = await plugin.catalog?.run({
      config,
      env: {},
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
      }),
    });
    if (!result || !("provider" in result) || !result.provider) {
      throw new Error("Missing actual ClawRouter catalog");
    }
    const selected = result.provider.models.find((model) => model.id === id);
    if (options.missing) {
      expect(selected).toBeUndefined();
      expect(requests).toHaveLength(0);
      return;
    }
    if (!selected || selected.api !== api || !selected.baseUrl) {
      throw new Error("Missing selected OpenCode route");
    }
    const model: Model = {
      ...selected,
      provider: "clawrouter",
      api,
      baseUrl: selected.baseUrl,
      input: ["text"],
    };
    await run({
      model,
      plugin,
      requests,
      catalogKeys,
      expectedUrl: "https://clawrouter.openclaw.ai/tenant" + publicPath,
    });
  });
}
