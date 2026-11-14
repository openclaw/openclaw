import { createServer, type IncomingHttpHeaders } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const MODEL_ID = "ollama/team/qwen3:4b";
const KEY = "synthetic-bifrost-key";
const provider = requireRegisteredProvider(capturePluginRegistration(plugin).providers, "bifrost");
function providerConfig(
  overrides: Partial<NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]>,
): OpenClawConfig {
  return { models: { providers: { bifrost: { baseUrl, models: [], ...overrides } } } };
}

function runNonInteractive({
  config = {},
  ...overrides
}: Pick<ProviderAuthMethodNonInteractiveContext, "opts"> &
  Partial<ProviderAuthMethodNonInteractiveContext>) {
  return provider.auth[0]?.runNonInteractive?.({
    authChoice: "bifrost-api-key",
    config,
    baseConfig: config,
    runtime: createRuntimeSpies(),
    resolveApiKey: async () => {
      throw new Error("Anonymous setup must not resolve credentials");
    },
    toApiKeyCredential: () => {
      throw new Error("Unsuccessful or anonymous setup must not store credentials");
    },
    ...overrides,
  });
}

const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
let baseUrl: string;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;
const server = createServer((req, res) => {
  req.resume();
  requests.push({ path: req.url ?? "", headers: { ...req.headers } });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: MODEL_ID, context_window: 32768 }] }));
    return;
  }
  res.writeHead(404).end(JSON.stringify({ error: "Unknown fixture endpoint" }));
});

async function configure({
  config = {},
  apiKey,
  assertCurrent,
}: {
  config?: OpenClawConfig;
  apiKey?: string;
  assertCurrent?: () => void;
} = {}) {
  const auth = provider.auth[0];
  if (!auth) {
    throw new Error("Expected Bifrost setup");
  }
  const result = await auth.run({
    config,
    opts: apiKey ? { bifrostApiKey: apiKey } : {},
    env: {},
    runtime: createRuntimeSpies(),
    prompter: createTestWizardPrompter({
      text: async ({ message }) => {
        if (/base URL/i.test(message)) {
          return baseUrl;
        }
        return /API key|virtual key/i.test(message) ? (apiKey ?? "") : MODEL_ID;
      },
    }),
    assertCurrent,
    secretInputMode: "plaintext",
    isRemote: false,
    ...createNoBrowserAuth(),
  });
  return {
    result,
    config: applyProviderAuthConfigPatch(config, result.configPatch, result),
  };
}

beforeAll(async () => {
  claim = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(claim.port, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${claim.port}/v1`;
});
beforeEach(() => {
  requests.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await server[Symbol.asyncDispose]();
  await claim.release();
});

it("clears old credentials before anonymous discovery and persists no-auth", async () => {
  const { result, config } = await configure({
    config: providerConfig({
      apiKey: "synthetic-old-key",
      headers: {
        Authorization: "Bearer synthetic-old-header",
        "x-bf-vk": "synthetic-old-vk",
      },
      request: {
        auth: { mode: "header", headerName: "x-bf-vk", value: "synthetic-old-request-vk" },
      },
    }),
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.authorization).toBeUndefined();
  expect(requests[0]?.headers["x-bf-vk"]).toBeUndefined();
  expect(result.profiles).toEqual([]);
  expect(config.models?.providers?.bifrost).toMatchObject({ auth: "none" });
  expect(config.models?.providers?.bifrost?.apiKey).toBeUndefined();
  expect(config.models?.providers?.bifrost?.request?.auth).toBeUndefined();
});

it("replaces stale no-auth with the supplied credential before discovery", async () => {
  const { config } = await configure({
    apiKey: KEY,
    config: providerConfig({ api: "openai-completions", auth: "none" }),
  });
  expect(requests.map(({ headers }) => headers.authorization)).toEqual([`Bearer ${KEY}`]);
  expect(config.models?.providers?.bifrost?.auth).not.toBe("none");
});

it("selects the discovered nested model ID with its reported context", async () => {
  const { result, config } = await configure();
  expect(requests.map(({ path }) => path)).toEqual(["/v1/models"]);
  expect(result.defaultModel).toBe(`bifrost/${MODEL_ID}`);
  expect(config.models?.providers?.bifrost?.models).toEqual([
    expect.objectContaining({ id: MODEL_ID, contextWindow: 32768 }),
  ]);
});

it("preserves configured routing headers during anonymous catalog refresh", async () => {
  await provider.catalog?.run({
    config: providerConfig({
      auth: "none",
      headers: { "x-tenant": "synthetic-tenant" },
      request: { headers: { "x-route": "synthetic-route" } },
    }),
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "synthetic-key", discoveryApiKey: "synthetic-key" }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.authorization).toBeUndefined();
  expect(requests[0]?.headers["x-tenant"]).toBe("synthetic-tenant");
  expect(requests[0]?.headers["x-route"]).toBe("synthetic-route");
});

it("rejects revoked setup authority before sending a request", async () => {
  const revoked = new Error("Setup configuration changed; run setup again.");
  const assertCurrent = () => {
    throw revoked;
  };
  await expect(configure({ assertCurrent })).rejects.toBe(revoked);
  expect(requests).toEqual([]);
});

it("non-interactive anonymous setup never resolves or stores a credential", async () => {
  const result = await runNonInteractive({
    config: providerConfig({ auth: "none" }),
    opts: { customBaseUrl: baseUrl, customModelId: MODEL_ID, customNoAuth: true },
  });
  expect(result?.models?.providers?.bifrost).toMatchObject({
    auth: "none",
    models: [expect.objectContaining({ id: MODEL_ID })],
  });
});

it.each([
  { customBaseUrl: "http://127.0.0.1:12345/v1", invalid: false },
  { customBaseUrl: "not-a-url", invalid: true },
  { customBaseUrl: "ftp://gateway.example/v1", invalid: true },
])(
  "reports non-interactive setup failure for $customBaseUrl",
  async ({ customBaseUrl, invalid }) => {
    const runtime = createRuntimeSpies();
    const resolveApiKey = vi.fn(async () =>
      invalid ? { key: KEY, source: "flag" as const } : null,
    );
    const result = await runNonInteractive({
      opts: { customBaseUrl, bifrostApiKey: invalid ? KEY : undefined },
      runtime,
      resolveApiKey,
    });
    expect(result).toBeNull();
    expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "bifrost",
        flagValue: invalid ? KEY : undefined,
        allowProfile: !invalid,
      }),
    );
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(invalid ? "full http:// or https:// URL" : "--custom-no-auth"),
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);
