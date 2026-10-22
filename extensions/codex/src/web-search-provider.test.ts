import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexWebSearchProvider as createContractCodexWebSearchProvider } from "../web-search-contract-api.js";
import {
  codexModel as baseModel,
  createClientFactory,
} from "./app-server/bounded-turn.test-harness.js";
import * as shared from "./app-server/shared-client.js";
import { createCodexWebSearchProvider } from "./web-search-provider.js";
// Loads the provider's lazy runtime at collection, outside the first test's deadline.
import "./web-search-provider.runtime.js";

afterEach(() => vi.restoreAllMocks());

function createFakeClient(options?: {
  emitWebSearch?: boolean;
  models?: ReturnType<typeof baseModel>[];
}) {
  const search = {
    id: "search-1",
    type: "webSearch",
    query,
    action: { type: "search", query, queries: [query] },
  };
  const answer = {
    id: "msg-1",
    type: "agentMessage",
    text: "Two current providers: Example One and Example Two.",
  };
  return createClientFactory({
    models: options?.models ?? [baseModel("gpt-5.5")],
    terminalItems: options?.emitWebSearch === false ? [answer] : [search, answer],
  });
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
  vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(fixture.factory);
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
    const { factory, request, methods, tool } = searchFixture(undefined, {
      appServer: {
        clearEnv: ["CODEX_HOME", "KEEP_CLEARED"],
      },
    });

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
    expect(methods).toEqual(["model/list", "thread/start", "turn/start"]);
    const threadStart = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(threadStart).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      cwd: expect.any(String),
      sandbox: "read-only",
      config: {
        "features.standalone_web_search": false,
        web_search: "live",
        "tools.web_search.allowed_domains": ["example.com"],
      },
    });
    const threadStartCwd = (threadStart as { cwd?: string } | undefined)?.cwd;
    const isolatedStartOptions = vi.mocked(factory).mock.calls[0]?.[0]?.startOptions;
    const isolatedCodexHome = isolatedStartOptions?.env?.CODEX_HOME;
    expect(threadStartCwd).not.toBe("/tmp/openclaw-agent");
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
    const { factory, methods } = createFakeClient();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const denial = new Error("search caller no longer authorized");
    let current = true;
    vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return factory();
    });
    const tool = createSearchTool(createCodexWebSearchProvider());
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
    expect(methods).toEqual([]);
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
    const { tool, methods: requested } = searchFixture(options, pluginConfig);
    await expect(tool?.execute({ query })).rejects.toThrow(error);
    if (methods) {
      expect(requested).toEqual(methods);
    }
  });
});
