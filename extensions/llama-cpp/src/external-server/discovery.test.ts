import type { IncomingMessage } from "node:http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { discoverLlamaServer } from "./discovery.js";

function withDiscovery(
  reply: (request: IncomingMessage) => unknown,
  run: (baseUrl: string) => Promise<void>,
) {
  return withServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const body = reply(request);
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  }, run);
}

const result = (id: string) => ({ kind: "success", models: [{ config: { id } }] });

it.each([
  {
    body: "<!doctype html><html><body>Local model app</body></html>",
    caps: { supports_reasoning_effort: true },
    reasoning: true,
  },
  {
    body: JSON.stringify({ app: "local-models" }),
    caps: { supports_reasoning_effort: false },
    reasoning: false,
  },
  { body: undefined, caps: {}, reasoning: false },
])("discovers rows with $caps behind $body", async ({ body, caps, reasoning }) => {
  const requests: string[] = [];
  await withDiscovery(
    ({ url }) => {
      requests.push(url ?? "");
      if (url === "/models" && body) {
        return body;
      }
      if (url?.endsWith("/models")) {
        return {
          data: [{ id: "qwen/model:Q4_K_M", object: "model", status: { value: "sleeping" } }],
        };
      }
      return url?.startsWith("/props")
        ? {
            default_generation_settings: { n_ctx: 32_768 },
            chat_template_caps: { ...caps, supports_tools: true, supports_tool_calls: true },
          }
        : {};
    },
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl: `${baseUrl}/v1` })).resolves.toMatchObject({
        kind: "success",
        endpoint: { origin: baseUrl, inferenceBaseUrl: `${baseUrl}/v1` },
        models: [
          {
            status: "sleeping",
            config: {
              id: "qwen/model:Q4_K_M",
              reasoning,
              contextWindow: 32_768,
              compat: { supportsTools: true, supportsReasoningEffort: reasoning },
            },
          },
        ],
      });
      expect(requests).toEqual([
        "/health",
        "/models",
        ...(body ? ["/v1/models"] : []),
        "/props?model=qwen%2Fmodel%3AQ4_K_M&autoload=false",
      ]);
    },
  );
});

it("attaches the normalized endpoint to shared discovery failures", async () => {
  await withDiscovery(
    () => ({}),
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl: `${baseUrl}/v1` })).resolves.toMatchObject({
        kind: "invalid-response",
        path: "/v1/models",
        endpoint: { origin: baseUrl, inferenceBaseUrl: `${baseUrl}/v1` },
      });
    },
  );
});

it.each([
  { name: "API key", access: { apiKey: "endpoint-key" } },
  { name: "authorization header", access: { headers: { Authorization: "Bearer endpoint-key" } } },
])("fetches fresh discovery for $name and subsequent anonymous requests", async ({ access }) => {
  let modelId = "anonymous-model";
  const modelRequests: Array<string | undefined> = [];
  await withDiscovery(
    (request) => {
      if (request.url === "/models") {
        modelRequests.push(request.headers.authorization);
        return { data: [{ id: modelId, status: { value: "unloaded" } }] };
      }
      return {};
    },
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(
        result("anonymous-model"),
      );
      modelId = "fresh-model";
      await expect(discoverLlamaServer({ baseUrl, ...access })).resolves.toMatchObject(
        result("fresh-model"),
      );
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(result("fresh-model"));
      expect(modelRequests).toEqual([undefined, "Bearer endpoint-key", undefined]);
    },
  );
});
