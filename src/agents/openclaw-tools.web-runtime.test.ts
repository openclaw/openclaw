import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...mod,
    resolvePluginTools: () => [],
  };
});

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function findTool(name: string, config: OpenClawConfig) {
  const allTools = createOpenClawTools({ config, sandboxed: true });
  const tool = allTools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error(`missing ${name} tool`);
  }
  return tool;
}

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

async function prepareAndActivate(params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv }) {
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: params.config,
    env: params.env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });
  activateSecretsRuntimeSnapshot(snapshot);
  return snapshot;
}

describe("openclaw tools runtime web metadata wiring", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    clearSecretsRuntimeSnapshot();
  });

  it("uses runtime-selected provider when higher-precedence provider ref is unresolved", async () => {
    const snapshot = await prepareAndActivate({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { source: "env", provider: "default", id: "MISSING_BRAVE_KEY_REF" },
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_WEB_KEY_REF" },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_WEB_KEY_REF: "gemini-runtime-key",
      },
    });

    expect(snapshot.webTools.search.selectedProvider).toBe("gemini");

    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: { parts: [{ text: "runtime gemini ok" }] },
                groundingMetadata: { groundingChunks: [] },
              },
            ],
          }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const webSearch = findTool("web_search", snapshot.config);
    const result = await webSearch.execute("call-runtime-search", { query: "runtime search" });

    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("generativelanguage.googleapis.com");
    expect((result.details as { provider?: string }).provider).toBe("gemini");
  });

  it("skips Firecrawl key resolution when runtime marks Firecrawl inactive", async () => {
    const snapshot = await prepareAndActivate({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                enabled: false,
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_KEY_REF" },
              },
            },
          },
        },
      }),
    });

    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "text/html; charset=utf-8" }),
        text: () =>
          Promise.resolve(
            "<html><body><article><h1>Runtime Off</h1><p>Use direct fetch.</p></article></body></html>",
          ),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const webFetch = findTool("web_fetch", snapshot.config);
    await webFetch.execute("call-runtime-fetch", { url: "https://example.com/runtime-off" });

    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/runtime-off");
    expect(String(mockFetch.mock.calls[0]?.[0])).not.toContain("api.firecrawl.dev");
  });
});
