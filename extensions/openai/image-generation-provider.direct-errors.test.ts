// Direct Images API failures keep the provider error and name the route and credential sent.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
// Prepare lazy SDK imports during collection, before any request deadline starts.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import {
  ensureAuthProfileStoreAsync,
  isProviderApiKeyConfiguredAsync,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { ProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import { withServer, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync,
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync,
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
function expectRouteDiagnostics(error: unknown, origin: string, credential: string) {
  for (const detail of [
    `route=images-api url=${origin}/v1/images/generations`,
    credential,
    'baseUrl "https://chatgpt.com/backend-api/codex"',
    'api "openai-chatgpt-responses"',
    "without apiKey",
    'auth "api-key"',
    "auth headers",
  ]) {
    expect(error).toHaveProperty("message", expect.stringContaining(detail));
  }
}

// Legacy Anthropic credentials still await migration, so unscoped auth-store reads refuse
// while OpenAI-scoped credential resolution stays allowed.
async function withPendingAnthropicMigration<T>(fn: (agentDir: string) => Promise<T>) {
  return withStateDirEnv("openai-image-direct-errors-", async ({ stateDir }) => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "legacy-key" },
        },
      }),
    );
    return fn(agentDir);
  });
}

async function generateAgainst(
  reply: { status: number; body: unknown },
  options: {
    authStore?: AuthProfileStore;
    providerConfig?: Omit<Parameters<typeof openAIImageConfig>[0], "baseUrl">;
  } = {},
) {
  return withPendingAnthropicMigration(async (agentDir) => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    let origin = "";
    let outcome: unknown;
    await withServer(
      (request, response) => {
        request.resume();
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.writeHead(reply.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(reply.body));
      },
      async (baseUrl) => {
        origin = baseUrl;
        outcome = await provider
          .generateImage({
            provider: "openai",
            model: "gpt-image-2",
            prompt: "Synthetic image",
            cfg: openAIImageConfig({
              baseUrl: `${baseUrl}/v1`,
              apiKey: "synthetic-openai-key",
              ...options.providerConfig,
            }),
            agentDir,
            authStore: options.authStore,
            ssrfPolicy: { allowedOrigins: [baseUrl] },
          })
          .catch((error: unknown) => error);
      },
    );
    return { origin, outcome, requests };
  });
}

beforeEach(() => {
  for (const name of [
    "OPENAI_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("starts from an agent whose unscoped auth read refuses another provider's migration", async () => {
  await withPendingAnthropicMigration(async (agentDir) => {
    await expect(
      ensureAuthProfileStoreAsync(agentDir, { allowKeychainPrompt: false }),
    ).rejects.toMatchObject({
      name: "AuthProfileMigrationRequiredError",
      affectedProviders: ["anthropic"],
    });
  });
});

describe("OpenAI direct image HTTP errors without a prepared auth store", () => {
  it.each([
    [401, "Missing scopes: api.model.images.request"],
    [403, "Project does not have access to model gpt-image-2"],
    [429, "Rate limit reached for images per minute"],
  ])("keeps HTTP %i as the provider error", async (status, detail) => {
    const { origin, outcome, requests } = await generateAgainst({
      status,
      body: { error: { message: detail } },
    });
    expect(requests).toEqual([
      { url: "/v1/images/generations", authorization: "Bearer synthetic-openai-key" },
    ]);
    expect(outcome).toBeInstanceOf(ProviderHttpError);
    expect(outcome).toMatchObject({ status, statusCode: status });
    const original = `OpenAI image generation failed (HTTP ${status}): ${detail}`;
    expect(outcome).toHaveProperty("message", expect.stringContaining(original));
    if (status === 429) {
      expect(outcome).toHaveProperty("message", original);
    } else {
      expectRouteDiagnostics(outcome, origin, "credential=api-key source=models.json");
    }
  });
});

it("returns the image when the same route succeeds", async () => {
  const { outcome, requests } = await generateAgainst({
    status: 200,
    body: { data: [{ b64_json: png.toString("base64") }] },
  });
  expect(requests).toHaveLength(1);
  expect(outcome).toMatchObject({ images: [{ buffer: png, mimeType: "image/png" }] });
});

it.each([
  {
    name: "the resolved OAuth profile",
    headers: undefined,
    token: "codex-access",
    credential: "credential=oauth source=profile:openai:default",
  },
  {
    name: "a configured auth header instead of the OAuth profile",
    headers: { Authorization: "Bearer header-key" },
    token: "header-key",
    credential: "credential=configured-header source=models.providers.openai",
  },
])("attributes $name on the explicit direct route", async ({ headers, token, credential }) => {
  const authStore = createCodexOAuthAuthStore();
  // Keep this diagnostic test out of the unrelated OAuth refresh path.
  authStore.profiles["openai:default"].expires = Date.now() + 3_600_000;
  const { origin, outcome, requests } = await generateAgainst(
    { status: 401, body: { error: { message: "Missing scopes: api.model.images.request" } } },
    {
      authStore,
      providerConfig: { apiKey: undefined, api: "openai-completions", headers },
    },
  );
  expect(outcome).toBeInstanceOf(ProviderHttpError);
  expect(requests).toEqual([{ url: "/v1/images/generations", authorization: `Bearer ${token}` }]);
  expect(outcome).toMatchObject({ status: 401, statusCode: 401 });
  expect(outcome).toHaveProperty(
    "message",
    expect.stringContaining("Missing scopes: api.model.images.request"),
  );
  expectRouteDiagnostics(outcome, origin, credential);
  for (const secret of ["codex-access", "codex-refresh", "header-key"]) {
    expect(outcome).toHaveProperty("message", expect.not.stringContaining(secret));
  }
  if (headers) {
    expect(outcome).toHaveProperty(
      "message",
      expect.not.stringContaining("profile:openai:default"),
    );
  }
});
