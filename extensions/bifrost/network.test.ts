import { createServer, type IncomingHttpHeaders } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  requireRegisteredProvider,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const MODEL_ID = "ollama/team/qwen3:4b";
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
  async function selectModel<T>(prompt: { options: Array<{ value: T }> }): Promise<T> {
    const selected = prompt.options.find(({ value }) => value === MODEL_ID);
    if (!selected) {
      throw new Error("Expected the discovered provider-qualified model in the picker");
    }
    return selected.value;
  }
  const prompter = createTestWizardPrompter({
    text: vi.fn(async (prompt: Parameters<WizardPrompter["text"]>[0]) => {
      if (/base URL/i.test(prompt.message)) {
        return baseUrl;
      }
      if (/API key|virtual key/i.test(prompt.message)) {
        return apiKey;
      }
      return MODEL_ID;
    }),
    select: selectModel,
  });
  vi.spyOn(prompter, "select");
  return prompter;
}

async function configure(
  params: {
    config?: OpenClawConfig;
    apiKey?: string;
    assertCurrent?: () => void;
  } = {},
) {
  const config = params.config ?? {};
  const provider = requireRegisteredProvider(
    capturePluginRegistration(plugin).providers,
    "bifrost",
  );
  const auth = provider.auth[0];
  if (!auth) {
    throw new Error("Expected Bifrost setup");
  }
  const prompter = createPrompter(params.apiKey);
  const context: ProviderAuthContext = {
    config,
    opts: params.apiKey ? { bifrostApiKey: params.apiKey } : {},
    env: {},
    runtime: createRuntimeSpies(),
    prompter,
    assertCurrent: params.assertCurrent,
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: async () => {
      throw new Error("Unexpected browser auth");
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth");
      },
    },
  };
  const result = await auth.run(context);
  return {
    result,
    prompter,
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await claim.release();
  });

  it("clears old credentials before anonymous discovery and persists no-auth", async () => {
    const { result, config } = await configure({
      config: {
        models: {
          providers: {
            bifrost: {
              baseUrl,
              api: "openai-completions",
              apiKey: "synthetic-old-key",
              headers: {
                Authorization: "Bearer synthetic-old-header",
                "x-bf-vk": "synthetic-old-vk",
              },
              request: {
                auth: { mode: "header", headerName: "x-bf-vk", value: "synthetic-old-request-vk" },
              },
              models: [],
            },
          },
        },
      },
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
      config: {
        models: {
          providers: { bifrost: { baseUrl, api: "openai-completions", auth: "none", models: [] } },
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-bifrost-key");
    expect(config.models?.providers?.bifrost?.auth).not.toBe("none");
  });

  it("selects the discovered nested model ID with its reported context", async () => {
    const { result, config, prompter } = await configure();
    expect(requests.map(({ path }) => path)).toEqual(["/v1/models"]);
    expect(prompter.select).toHaveBeenCalledOnce();
    expect(result.defaultModel).toBe(`bifrost/${MODEL_ID}`);
    expect(config.models?.providers?.bifrost?.models).toEqual([
      expect.objectContaining({ id: MODEL_ID, contextWindow: 32768 }),
    ]);
  });

  it("preserves configured routing headers during anonymous catalog refresh", async () => {
    const provider = requireRegisteredProvider(
      capturePluginRegistration(plugin).providers,
      "bifrost",
    );
    await provider.catalog?.run({
      config: {
        models: {
          providers: {
            bifrost: {
              baseUrl,
              auth: "none",
              headers: { "x-tenant": "synthetic-tenant" },
              request: { headers: { "x-route": "synthetic-route" } },
              models: [],
            },
          },
        },
      },
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
  const provider = requireRegisteredProvider(
    capturePluginRegistration(plugin).providers,
    "bifrost",
  );
  const config: OpenClawConfig = {
    models: { providers: { bifrost: { baseUrl, auth: "none", models: [] } } },
  };
  const result = await provider.auth[0]?.runNonInteractive?.({
    authChoice: "bifrost-api-key",
    config,
    baseConfig: config,
    opts: { customBaseUrl: baseUrl, customModelId: MODEL_ID, customNoAuth: true },
    runtime: createRuntimeSpies(),
    resolveApiKey: async () => {
      throw new Error("Anonymous setup must not resolve credentials");
    },
    toApiKeyCredential: () => {
      throw new Error("Anonymous setup must not store credentials");
    },
  });
  expect(result?.models?.providers?.bifrost).toMatchObject({
    auth: "none",
    models: [expect.objectContaining({ id: MODEL_ID })],
  });
});

it("reports a failing exit status when non-interactive credentials are missing", async () => {
  const provider = requireRegisteredProvider(
    capturePluginRegistration(plugin).providers,
    "bifrost",
  );
  const runtime = createRuntimeSpies();
  const result = await provider.auth[0]?.runNonInteractive?.({
    authChoice: "bifrost-api-key",
    config: {},
    baseConfig: {},
    opts: { customBaseUrl: "http://127.0.0.1:12345/v1", customModelId: MODEL_ID },
    runtime,
    resolveApiKey: async () => null,
    toApiKeyCredential: () => {
      throw new Error("Missing credentials must not be stored");
    },
  });
  expect(result).toBeNull();
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--custom-no-auth"));
  expect(runtime.exit).toHaveBeenCalledWith(1);
});
