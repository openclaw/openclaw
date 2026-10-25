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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const MODEL_ID = "ollama/team/qwen3:4b";
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

function createPrompter(apiKey = "") {
  return createTestWizardPrompter({
    text: async (prompt) => {
      if (/base URL/i.test(prompt.message)) {
        return baseUrl;
      }
      if (/API key|virtual key/i.test(prompt.message)) {
        return apiKey;
      }
      return MODEL_ID;
    },
    async select<T>(prompt: { options: Array<{ value: T }> }): Promise<T> {
      const selected = prompt.options.find(({ value }) => value === MODEL_ID);
      if (!selected) {
        throw new Error("Expected the discovered provider-qualified model in the picker");
      }
      return selected.value;
    },
  });
}

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
    prompter: createPrompter(apiKey),
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

describe("Bifrost setup over HTTP", () => {
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
        api: "openai-completions",
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
      apiKey: "synthetic-bifrost-key",
      config: providerConfig({ api: "openai-completions", auth: "none" }),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-bifrost-key");
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
    await expect(
      configure({
        assertCurrent: () => {
          throw revoked;
        },
      }),
    ).rejects.toBe(revoked);
    expect(requests).toEqual([]);
  });
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

it("reports a failing exit status when non-interactive credentials are missing", async () => {
  const runtime = createRuntimeSpies();
  const result = await runNonInteractive({
    opts: { customBaseUrl: "http://127.0.0.1:12345/v1", customModelId: MODEL_ID },
    runtime,
    resolveApiKey: async () => null,
  });
  expect(result).toBeNull();
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--custom-no-auth"));
  expect(runtime.exit).toHaveBeenCalledWith(1);
});

it.each(["not-a-url", "ftp://gateway.example/v1"])(
  "reports an actionable error after resolving the setup key for invalid URL %s",
  async (customBaseUrl) => {
    const runtime = createRuntimeSpies();
    const resolveApiKey = vi.fn(async () => ({
      key: "synthetic-bifrost-key",
      source: "flag" as const,
    }));
    await expect(
      runNonInteractive({
        opts: { customBaseUrl, bifrostApiKey: "synthetic-bifrost-key" },
        runtime,
        resolveApiKey,
      }),
    ).resolves.toBeNull();
    expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith({
      provider: "bifrost",
      flagValue: "synthetic-bifrost-key",
      allowProfile: false,
      flagName: "--bifrost-api-key",
      envVar: "BIFROST_VIRTUAL_KEY",
      required: false,
    });
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "The Bifrost gateway URL must be a full http:// or https:// URL, such as http://localhost:8080/openai/v1.",
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);
