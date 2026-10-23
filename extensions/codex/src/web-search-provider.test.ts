import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexWebSearchProvider as createContractCodexWebSearchProvider } from "../web-search-contract-api.js";
import { codexModel as baseModel } from "./app-server/bounded-turn.test-harness.js";
import {
  createFakeCodexAppServerClient,
  threadStartResult as baseThreadStartResult,
  turnStartResult as baseTurnStartResult,
} from "./app-server/codex-app-server.test-fixtures.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import * as shared from "./app-server/shared-client.js";
import { createCodexWebSearchProvider } from "./web-search-provider.js";
// Loads the provider's lazy runtime at collection, outside the first test's deadline.
import "./web-search-provider.runtime.js";

afterEach(() => vi.restoreAllMocks());

function threadStartResult(model: string) {
  const result = baseThreadStartResult("thread-1", "/tmp/openclaw-agent");
  return {
    ...result,
    thread: {
      ...result.thread,
      ephemeral: true,
      cliVersion: "0.149.0",
    },
    model,
    approvalPolicy: "on-request",
  };
}

function createFakeClient(options?: {
  emitWebSearch?: boolean;
  models?: ReturnType<typeof baseModel>[];
}) {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const fixture = createFakeCodexAppServerClient(async (method, params) => {
    requests.push({ method, params });
    if (method === "model/list") {
      return { data: options?.models ?? [baseModel("gpt-5.5")], nextCursor: null };
    }
    if (method === "thread/start" && isJsonObject(params) && typeof params.model === "string") {
      return threadStartResult(params.model);
    }
    if (method === "turn/start") {
      const scope = { threadId: "thread-1", turnId: "turn-1" };
      for (const handler of fixture.notifications) {
        const notify = (eventMethod: string, eventParams: JsonValue) =>
          handler({ method: eventMethod, params: eventParams });
        if (options?.emitWebSearch !== false) {
          await notify("item/completed", {
            ...scope,
            item: {
              id: "search-1",
              type: "webSearch",
              query,
              action: { type: "search", query, queries: [query] },
            },
          });
        }
        await notify("item/agentMessage/delta", {
          ...scope,
          itemId: "msg-1",
          delta: "Two current providers: Example One and Example Two.",
        });
        await notify("turn/completed", {
          ...scope,
          turn: baseTurnStartResult("turn-1", "completed").turn,
        });
      }
      return baseTurnStartResult();
    }
    return {};
  });

  return { client: fixture.client, requests };
}

const query = "plumbers in Edmonton Alberta";
const config: OpenClawConfig = {
  tools: {
    web: {
      search: {
        provider: "codex",
        timeoutSeconds: 30,
        openaiCodex: {
          enabled: true,
          mode: "live",
          allowedDomains: ["example.com"],
          contextSize: "high",
          userLocation: {
            country: "CA",
            region: "Alberta",
            city: "Edmonton",
            timezone: "America/Edmonton",
          },
        },
      },
    },
  },
};

function createSearchTool(provider: ReturnType<typeof createCodexWebSearchProvider>) {
  return provider.createTool({
    config,
    searchConfig: config.tools?.web?.search,
    agentDir: "/tmp/openclaw-agent",
  });
}

function searchFixture(options?: Parameters<typeof createFakeClient>[0], pluginConfig?: unknown) {
  const fixture = createFakeClient(options);
  vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockResolvedValue(fixture.client);
  const tool = createSearchTool(
    createCodexWebSearchProvider({
      resolvePluginConfig: () => pluginConfig,
    }),
  );
  return { ...fixture, tool };
}

describe("codex web search provider", () => {
  it("registers a selectable keyless provider contract", () => {
    const provider = createContractCodexWebSearchProvider();

    expect(provider).toMatchObject({
      id: "codex",
      label: "Codex Hosted Search",
      requiresCredential: false,
      envVars: [],
      autoDetectOrder: 900,
    });
    expect(provider.applySelectionConfig?.({}).plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("honors the explicit Codex hosted-search opt-out", () => {
    const provider = createCodexWebSearchProvider();

    expect(
      provider.createTool({
        searchConfig: { provider: "codex", openaiCodex: { enabled: false } },
      }),
    ).toBeNull();
  });

  it("runs an isolated grounded Codex search with configured restrictions", async () => {
    const { client, requests } = createFakeClient();
    let isolatedStartOptions: CodexAppServerStartOptions | undefined;
    vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(async (options) => {
      isolatedStartOptions = options?.startOptions;
      return client;
    });
    const provider = createCodexWebSearchProvider({
      resolvePluginConfig: () => ({
        appServer: {
          args: [
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            "openai_base_url=http://127.0.0.1:44080/v1",
            "--config=model_catalog_json=/tmp/qa catalog/models.json",
            "-c",
            "mcp_servers.external.command='unsafe'",
          ],
          clearEnv: ["CODEX_HOME", "KEEP_CLEARED"],
        },
      }),
    });
    const tool = createSearchTool(provider);

    const result = await tool?.execute({ query });

    expect(result).toMatchObject({
      query,
      provider: "codex",
      model: "gpt-5.5",
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "codex",
        wrapped: true,
      },
      searches: [{ query, queries: [query] }],
    });
    expect(result?.content).toContain("Two current providers");
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[1]?.params).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      cwd: expect.any(String),
      approvalPolicy: "on-request",
      sandbox: "read-only",
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      config: {
        "features.code_mode": false,
        "features.code_mode_only": false,
        "features.hooks": false,
        "features.standalone_web_search": false,
        notify: [],
        web_search: "live",
        "tools.web_search.allowed_domains": ["example.com"],
        "tools.web_search.context_size": "high",
        "tools.web_search.location.country": "CA",
        "tools.web_search.location.region": "Alberta",
        "tools.web_search.location.city": "Edmonton",
        "tools.web_search.location.timezone": "America/Edmonton",
      },
    });
    const threadStartCwd = (requests[1]?.params as { cwd?: string } | undefined)?.cwd;
    const isolatedCodexHome = isolatedStartOptions?.env?.CODEX_HOME;
    expect(threadStartCwd).not.toBe("/tmp/openclaw-agent");
    expect(isolatedStartOptions?.args).toEqual([
      "app-server",
      "-c",
      "openai_base_url=http://127.0.0.1:44080/v1",
      "-c",
      "model_catalog_json=/tmp/qa catalog/models.json",
      "-c",
      "project_root_markers=[]",
      "--listen",
      "stdio://",
    ]);
    expect(isolatedStartOptions?.clearEnv).toEqual([
      "KEEP_CLEARED",
      "OPENCLAW_CODEX_APP_SERVER_ARGS",
    ]);
    expect(isolatedCodexHome).toEqual(expect.any(String));
    if (!threadStartCwd || !isolatedCodexHome) {
      throw new Error("expected isolated Codex home and workspace");
    }
    expect(path.dirname(threadStartCwd)).toBe(path.dirname(isolatedCodexHome));
  });

  it("does not send app-server requests after authority ends during client preparation", async () => {
    const { client, requests } = createFakeClient();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const denial = new Error("search caller no longer authorized");
    let current = true;
    vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return client;
    });
    const provider = createCodexWebSearchProvider();
    const tool = provider.createTool({ config, searchConfig: config.tools?.web?.search });
    const pending = tool!.execute(
      { query: "synthetic authority probe" },
      {
        assertCurrent: () => {
          if (!current) {
            throw denial;
          }
        },
      },
    );
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toBe(denial);
    expect(requests).toEqual([]);
  });

  it.each([
    {
      name: "unisolatable transport",
      options: {},
      pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:4501" } },
      error: "Bounded Codex turns require stdio transport so native tools can be isolated.",
    },
    {
      name: "no text-capable model",
      options: { models: [{ ...baseModel("image-only"), inputModalities: ["image"] }] },
      error: "Codex app-server has no model supporting text input.",
      methods: ["model/list"],
    },
    {
      name: "ungrounded answer",
      options: { emitWebSearch: false },
      error: "Codex hosted search completed without invoking web search.",
    },
  ])("fails closed for $name", async ({ options, pluginConfig, error, methods }) => {
    const { tool, requests } = searchFixture(options, pluginConfig);
    await expect(tool?.execute({ query })).rejects.toThrow(error);
    if (methods) {
      expect(requests.map((entry) => entry.method)).toEqual(methods);
    }
  });
});
