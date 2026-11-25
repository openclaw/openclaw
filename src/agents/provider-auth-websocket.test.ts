import { createServer } from "node:http";
import { getAiTransportHost, runWithAiTransportHost } from "@openclaw/ai";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { afterEach, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../../packages/ai/src/providers/openai-chatgpt-responses.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import "../llm/ai-transport-host.js";
import { attachProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import { makeResponsesModel } from "./openai-transport-stream.test-harness.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

const websocketDispatch = vi.hoisted(() =>
  vi.fn(function unexpectedWebSocket() {
    throw new Error("Unexpected WebSocket dispatch");
  }),
);

vi.mock("openai/resources/responses/ws.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openai/resources/responses/ws.js")>()),
  ResponsesWS: websocketDispatch,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(
  (["openai-responses", "openai-chatgpt-responses"] as const).flatMap((api) =>
    [false, true].map((revoke) => ({ api, revoke })),
  ),
)("uses guarded HTTP for $api (revoked after preparation: $revoke)", async ({ api, revoke }) => {
  const credentials: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    credentials.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"type":"response.completed","response":{"id":"resp_authorized","status":"completed"}}\n\n',
      );
    });
  });
  const origin = await listenLoopback(server);
  try {
    let current = true;
    const model = attachProviderAuthAuthority(makeResponsesModel({ api }), () => {
      if (!current) {
        throw new Error("Plugin credential authority revoked");
      }
    });
    const token = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url");
    const apiKey = `e30.${token}.signature`;
    const host = {
      ...getAiTransportHost(),
      buildModelFetch: (requestModel: typeof model) => {
        // Keep native endpoint selection, but route guarded HTTP to a real local fixture.
        const guarded = buildGuardedModelFetch({ ...requestModel, baseUrl: `${origin}/v1` });
        return ((input, init) => {
          const request = new Request(input, init);
          return guarded(new Request(`${origin}${new URL(request.url).pathname}`, request));
        }) satisfies typeof fetch;
      },
    };
    vi.stubGlobal("WebSocket", websocketDispatch);
    const result = await runWithAiTransportHost(host, async () => {
      const context = {
        messages: [{ role: "user" as const, content: "Reply", timestamp: 0 }],
        tools: [],
      };
      const options = {
        apiKey,
        transport: "websocket-cached" as const,
        onPayload: async () => {
          await Promise.resolve();
          current = !revoke;
        },
      };
      const stream =
        api === "openai-chatgpt-responses"
          ? streamOpenAICodexResponses({ ...model, api }, context, options)
          : await createOpenAIResponsesTransportStreamFn()(model, context, options);
      return stream.result();
    });
    expect(websocketDispatch).not.toHaveBeenCalled();
    expect(credentials).toEqual(revoke ? [] : [`Bearer ${apiKey}`]);
    expect(result.stopReason).toBe(revoke ? "error" : "stop");
  } finally {
    await closeHttpServer(server);
  }
});
