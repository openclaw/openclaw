import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import { discoverLlamaServer } from "./discovery.js";

const discoverRowsMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>()),
  discoverOpenAICompatibleLocalModels: discoverRowsMock,
}));

async function useRealDiscovery() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-setup")>(
    "openclaw/plugin-sdk/provider-setup",
  );
  discoverRowsMock.mockImplementation(actual.discoverOpenAICompatibleLocalModels);
}

const endpoint = {
  origin: "http://localhost:8080",
  inferenceBaseUrl: "http://localhost:8080/v1",
};

beforeEach(() => {
  discoverRowsMock.mockReset();
});

it.each([
  { caps: { supports_reasoning_effort: true }, reasoning: true },
  { caps: { supports_reasoning_effort: false }, reasoning: false },
  { caps: {}, reasoning: false },
])("projects model rows with $caps", async ({ caps, reasoning }) => {
  discoverRowsMock.mockResolvedValue({
    kind: "success",
    rows: [
      {
        model: { id: "qwen/model:Q4_K_M", object: "model", status: { value: "sleeping" } },
        props: {
          default_generation_settings: { n_ctx: 32_768 },
          chat_template_caps: { ...caps, supports_tools: true, supports_tool_calls: true },
        },
      },
    ],
  });

  await expect(discoverLlamaServer({ baseUrl: endpoint.inferenceBaseUrl })).resolves.toMatchObject({
    kind: "success",
    endpoint,
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
});

it("attaches the normalized endpoint to shared discovery failures", async () => {
  discoverRowsMock.mockResolvedValue({
    kind: "invalid-response",
    path: "/models",
    error: new Error("malformed"),
  });

  await expect(discoverLlamaServer({ baseUrl: "localhost:8080" })).resolves.toMatchObject({
    kind: "invalid-response",
    path: "/models",
    endpoint,
  });
});

it.each([
  { name: "HTML app shell", body: "<!doctype html><html><body>Local model app</body></html>" },
  { name: "non-model JSON", body: JSON.stringify({ app: "local-models" }) },
])("discovers an existing server behind a root $name response", async ({ body }) => {
  await useRealDiscovery();
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/models") {
        response.end(body);
      } else if (request.url === "/v1/models") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "local-model", object: "model" }] }));
      } else {
        response.end("{}");
      }
    },
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject({
        kind: "success",
        models: [{ config: { id: "local-model" } }],
      });
      expect(requests).toEqual(["/health", "/models", "/v1/models", "/props"]);
    },
  );
});

it.each([
  { name: "API key", access: { apiKey: "endpoint-key" } },
  { name: "authorization header", access: { headers: { Authorization: "Bearer endpoint-key" } } },
  { name: "anonymous access", access: {} },
])("fetches fresh discovery for $name and subsequent anonymous requests", async ({ access }) => {
  await useRealDiscovery();
  let modelId = "anonymous-model";
  const modelRequests: Array<string | undefined> = [];
  await withServer(
    (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/models") {
        modelRequests.push(request.headers.authorization);
        response.end(JSON.stringify({ data: [{ id: modelId, status: { value: "unloaded" } }] }));
      } else {
        response.end("{}");
      }
    },
    async (baseUrl) => {
      const result = (id: string) => ({ kind: "success", models: [{ config: { id } }] });
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(
        result("anonymous-model"),
      );
      modelId = "fresh-model";
      await expect(discoverLlamaServer({ baseUrl, ...access })).resolves.toMatchObject(
        result("fresh-model"),
      );
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(result("fresh-model"));
      expect(modelRequests).toEqual([
        undefined,
        "apiKey" in access || "headers" in access ? "Bearer endpoint-key" : undefined,
        undefined,
      ]);
    },
  );
});
