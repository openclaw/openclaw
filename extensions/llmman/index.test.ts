import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  capturePluginRegistration,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin, { formatLlmmanModelName } from "./index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:17434/v1";
const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
);

type StubServer = { baseUrl: string; authorization: (string | undefined)[]; close: () => void };

async function startStubServer(models: string[]): Promise<StubServer> {
  const authorization: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    authorization.push(req.headers.authorization);
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, authorization, close: () => server.close() };
}

const provider = () =>
  requireRegisteredProvider(capturePluginRegistration(plugin).providers, "llmman");

function catalog(config: OpenClawConfig, key: string | undefined) {
  return runProviderCatalog({
    provider: provider(),
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: key, discoveryApiKey: key }),
    resolveProviderAuth: () => ({ apiKey: key, mode: "api_key", source: "profile" }),
  });
}

function wildcardConfig(baseUrl?: string): OpenClawConfig {
  return {
    agents: { defaults: { models: { "llmman/*": {} } } },
    models: {
      providers: {
        llmman: { ...(baseUrl ? { baseUrl } : {}), api: "openai-completions", models: [] },
      },
    },
  } as OpenClawConfig;
}

const servers: StubServer[] = [];
async function stub(models: string[]) {
  const server = await startStubServer(models);
  servers.push(server);
  return server;
}

beforeEach(async () => {
  // Local discovery returns early under test; these cases exercise the real probe.
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "development");
  const { clearLiveCatalogCacheForTests } =
    await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
  clearLiveCatalogCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.close();
  }
});

it("declares an app-guided API-key choice and local pricing", () => {
  // A declared non-secret marker would make a saved llmman-local profile read as unavailable.
  expect(manifest.nonSecretAuthMarkers).toBeUndefined();
  expect(manifest).toMatchObject({
    id: "llmman",
    providers: ["llmman"],
    modelPricing: { providers: { llmman: { external: false } } },
    modelCatalog: { discovery: { llmman: "refreshable" } },
    setup: { providers: [{ id: "llmman", envVars: ["LLMMAN_API_KEY"] }] },
  });
  expect(manifest.providerAuthChoices).toEqual([
    expect.objectContaining({
      provider: "llmman",
      method: "api-key",
      choiceId: "llmman-api-key",
      appGuidedSecret: true,
      choiceLabel: "llmman",
      groupId: "llmman",
      groupLabel: "llmman",
    }),
  ]);
});

it("registers one provider whose API-key method matches the manifest choice", () => {
  const registered = provider();
  expect(registered).toMatchObject({ id: "llmman", label: "llmman", envVars: ["LLMMAN_API_KEY"] });
  expect(registered.auth.map((method) => method.id)).toEqual(["api-key"]);
  expect(registered.catalog?.order).toBe("late");
});

it("discovers models, keeping their ids and shortening only the display names", async () => {
  const server = await stub(["docker.io/ai/gemma4:latest", "hf.co/unsloth/Qwen3.5-0.8B-GGUF"]);
  const result = await catalog(wildcardConfig(`${server.baseUrl}/`), "llmman-local");
  expect(result).toMatchObject({
    provider: { baseUrl: server.baseUrl, api: "openai-completions", apiKey: "llmman-local" },
  });
  const models = result && "provider" in result ? result.provider.models : [];
  expect(models.map((model) => [model.id, model.name])).toEqual([
    ["docker.io/ai/gemma4:latest", "gemma4"],
    ["hf.co/unsloth/Qwen3.5-0.8B-GGUF", "hf.co/unsloth/Qwen3.5-0.8B-GGUF"],
  ]);
});

it.each([
  ["docker.io/ai/gemma4:latest", "gemma4"],
  ["docker.io/ai/qwen3.8:27b", "qwen3.8:27b"],
  ["docker.io/alternate-ai-place/gemma4", "alternate-ai-place/gemma4"],
  ["registry.example.com/ai/gemma4:latest", "registry.example.com/ai/gemma4"],
  ["registry.example.com/ai/gemma4:7b", "registry.example.com/ai/gemma4:7b"],
  ["ai/gemma4", "ai/gemma4"],
  ["docker.io/ai/", "ai/"],
  [":latest", ":latest"],
])("formats model reference %s as %s", (id, name) => {
  expect(formatLlmmanModelName(id)).toBe(name);
});

it("sends the saved key as the bearer, the llmman-local placeholder included", async () => {
  const local = await stub(["qwen3.8"]);
  await catalog(wildcardConfig(local.baseUrl), "llmman-local");
  expect(local.authorization).toEqual(["Bearer llmman-local"]);

  const remote = await stub(["qwen3.8"]);
  await catalog(wildcardConfig(remote.baseUrl), "synthetic-remote-key");
  expect(remote.authorization).toEqual(["Bearer synthetic-remote-key"]);
});

it("discovers at the default local address when nothing is configured", async () => {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Response.json({ data: [{ id: "docker.io/ai/qwen3.8:latest", object: "model" }] });
    }),
  );
  const result = await catalog({}, "llmman-local");
  expect(requested).toEqual([`${DEFAULT_BASE_URL}/models`]);
  expect(result).toMatchObject({
    provider: {
      baseUrl: DEFAULT_BASE_URL,
      api: "openai-completions",
      apiKey: "llmman-local",
      models: [{ id: "docker.io/ai/qwen3.8:latest" }],
    },
  });
});

it("leaves a documented manual config alone: no discovery, nothing merged", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const manual: OpenClawConfig = {
    agents: { defaults: { model: { primary: "llmman/qwen3.8" } } },
    models: {
      mode: "merge",
      providers: {
        llmman: {
          baseUrl: "http://gpu-box.local:17434/v1",
          apiKey: "${LLMMAN_API_KEY}",
          api: "openai-completions",
          timeoutSeconds: 300,
          models: [
            {
              id: "qwen3.8",
              name: "Qwen3.8 (llmman)",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 65536,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  };
  const before = structuredClone(manual);
  await expect(catalog(manual, "llmman-local")).resolves.toBeNull();
  expect(manual).toEqual(before);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("returns no models, and does not throw, when no llmman server is running", async () => {
  const server = await startStubServer([]);
  const { baseUrl } = server;
  server.close();
  await expect(catalog(wildcardConfig(baseUrl), "llmman-local")).resolves.toMatchObject({
    provider: { baseUrl, api: "openai-completions", models: [] },
  });
});

it("stays off without a credential", async () => {
  await expect(catalog({}, undefined)).resolves.toBeNull();
});
