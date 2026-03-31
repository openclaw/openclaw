import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../engine-host-api.js";
import { MemoryHubSearchManager } from "../hub-search-manager.js";

function createConfig(params?: {
  agentId?: string;
  query?: { maxResults?: number; minScore?: number };
  memoryHub?: {
    baseUrl?: string;
    apiKey?: string;
    timeout?: number;
    timeoutMs?: number;
    readVisibility?: "private" | "shared" | "auto";
    searchVisibility?: "private" | "shared";
    agentIdMap?: Record<string, string>;
  };
}): OpenClawConfig {
  const agentId = params?.agentId ?? "main";
  return {
    agents: {
      defaults: {
        memorySearch: {
          provider: "memory-hub",
          query: params?.query,
          memoryHub: {
            baseUrl: params?.memoryHub?.baseUrl,
            apiKey: params?.memoryHub?.apiKey,
            timeout: params?.memoryHub?.timeout,
            timeoutMs: params?.memoryHub?.timeoutMs,
            readVisibility: params?.memoryHub?.readVisibility,
            searchVisibility: params?.memoryHub?.searchVisibility,
            agentIdMap: params?.memoryHub?.agentIdMap,
          },
        },
      },
      list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }],
    },
  } as OpenClawConfig;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEMORY_HUB_BASE_URL;
  delete process.env.MEMORY_HUB_API_KEY;
  delete process.env.MEMORY_HUB_READ_VISIBILITY;
  delete process.env.MEMORY_HUB_SEARCH_VISIBILITY;
});

describe("MemoryHubSearchManager", () => {
  it("uses /memories/search/batch when available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:8000/api/v1/memories/search/batch");
      expect(init?.method).toBe("POST");
      const parsedBody = JSON.parse(String(init?.body ?? "{}"));
      expect(parsedBody).toEqual({
        queries: [
          {
            agent_id: "hub-main",
            query: "用户偏好",
            limit: 5,
            visibility: "shared",
          },
        ],
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            total: 1,
            succeeded: 1,
            failed: 0,
            partial_success: false,
            results: [
              {
                index: 0,
                success: true,
                data: {
                  count: 2,
                  items: [
                    {
                      id: "m-1",
                      content: "用户喜欢简洁回答",
                      similarity: 0.81,
                    },
                    {
                      id: "m-2",
                      content: "喜欢列表格式",
                      score: 0.77,
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      query: { maxResults: 8, minScore: 0.35 },
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        searchVisibility: "shared",
        agentIdMap: { main: "hub-main" },
      },
    });

    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    const results = await manager.search("用户偏好", {
      maxResults: 5,
      minScore: 0.42,
    });

    expect(results).toEqual([
      {
        path: "memory-hub://main/m-1",
        startLine: 1,
        endLine: 1,
        score: 0.81,
        snippet: "用户喜欢简洁回答",
        source: "memory",
        citation: "memory-hub:m-1",
      },
      {
        path: "memory-hub://main/m-2",
        startLine: 1,
        endLine: 1,
        score: 0.77,
        snippet: "喜欢列表格式",
        source: "memory",
        citation: "memory-hub:m-2",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults search visibility to private when not configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:8000/api/v1/memories/search/batch");
      const parsedBody = JSON.parse(String(init?.body ?? "{}"));
      expect(parsedBody).toEqual({
        queries: [
          {
            agent_id: "hub-main",
            query: "默认可见性",
            limit: 4,
            visibility: "private",
          },
        ],
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            total: 1,
            succeeded: 1,
            failed: 0,
            partial_success: false,
            results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        agentIdMap: { main: "hub-main" },
      },
    });

    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    const results = await manager.search("默认可见性", { maxResults: 4 });

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses YAML searchVisibility when config does not set it", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-${Date.now()}-1`;
    const yamlPath = `${tmpRoot}/config/memory-hub.yml`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      yamlPath,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  searchVisibility: shared",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe("http://localhost:8000/api/v1/memories/search/batch");
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("shared");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("yaml visibility", { maxResults: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers config searchVisibility over YAML value", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-${Date.now()}-2`;
    const yamlPath = `${tmpRoot}/config/memory-hub.yml`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      yamlPath,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  searchVisibility: shared",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe("http://localhost:8000/api/v1/memories/search/batch");
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("private");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const cfg = createConfig({
        memoryHub: {
          searchVisibility: "private",
        },
      });
      const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
      await manager.search("yaml override", { maxResults: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from config and falls back to YAML before env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-invalid-yaml-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: shared",
        "  searchVisibility: shared",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("shared");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-invalid-config-yaml?request_agent_id=main&visibility=shared",
        );
        return new Response(
          JSON.stringify({ id: "m-invalid-config-yaml", content: "yaml visibility" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const invalidConfig = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: "invalid",
                searchVisibility: "invalid",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const manager = await MemoryHubSearchManager.create({ cfg: invalidConfig, agentId: "main" });
      await manager.search("invalid config yaml visibility", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-invalid-config-yaml" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from config and falls back to normalized YAML before env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-invalid-yaml-normalized-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: ' Shared '",
        "  searchVisibility: ' Private '",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("private");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-invalid-config-yaml-normalized?request_agent_id=main&visibility=shared",
        );
        return new Response(
          JSON.stringify({
            id: "m-invalid-config-yaml-normalized",
            content: "yaml normalized visibility",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const invalidConfig = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: "invalid",
                searchVisibility: "invalid",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const manager = await MemoryHubSearchManager.create({ cfg: invalidConfig, agentId: "main" });
      await manager.search("invalid config normalized yaml visibility", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-invalid-config-yaml-normalized" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("normalizes valid visibility values from YAML", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-normalize-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: ' AUTO '",
        "  searchVisibility: ' Shared '",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("shared");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-yaml-normalized?request_agent_id=main&visibility=auto",
        );
        return new Response(
          JSON.stringify({ id: "m-yaml-normalized", content: "yaml normalized" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("yaml normalized visibility", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-yaml-normalized" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from YAML and falls back to env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-invalid-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: invalid",
        "  searchVisibility: invalid",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("shared");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-invalid-yaml?request_agent_id=main&visibility=shared",
        );
        return new Response(JSON.stringify({ id: "m-invalid-yaml", content: "yaml read" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("invalid yaml visibility", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-invalid-yaml" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers YAML visibility values over normalized env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = " AUTO ";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = " Shared ";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-over-env-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: shared",
        "  searchVisibility: private",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("private");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-yaml-over-env?request_agent_id=main&visibility=shared",
        );
        return new Response(JSON.stringify({ id: "m-yaml-over-env", content: "yaml over env" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("yaml over env visibility", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-yaml-over-env" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers normalized YAML visibility values over normalized env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = " auto ";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = " shared ";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-env-normalized-priority-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: ' Shared '",
        "  searchVisibility: ' Private '",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("private");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-yaml-env-normalized-priority?request_agent_id=main&visibility=shared",
        );
        return new Response(
          JSON.stringify({
            id: "m-yaml-env-normalized-priority",
            content: "yaml normalized priority",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("yaml normalized over env normalized", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-yaml-env-normalized-priority" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from YAML and falls back to defaults", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-invalid-default-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: invalid",
        "  searchVisibility: invalid",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("private");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-invalid-yaml-default?request_agent_id=main&visibility=auto",
        );
        return new Response(
          JSON.stringify({ id: "m-invalid-yaml-default", content: "yaml default" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.search("invalid yaml defaults", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-invalid-yaml-default" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("falls back to /memories/search/text when batch search is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        return new Response("not found", { status: 404 });
      }
      expect(url).toBe("http://localhost:8000/api/v1/memories/search/text");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify([
          {
            id: "m-3",
            content: "回退到文本搜索",
            similarity: 0.66,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        agentIdMap: { main: "hub-main" },
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    const results = await manager.search("回退测试", { maxResults: 3, minScore: 0.2 });
    expect(results).toEqual([
      {
        path: "memory-hub://main/m-3",
        startLine: 1,
        endLine: 1,
        score: 0.66,
        snippet: "回退到文本搜索",
        source: "memory",
        citation: "memory-hub:m-3",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps /memories/search/text legacy response after batch fallback", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        return new Response("not found", { status: 404 });
      }
      expect(url).toBe("http://localhost:8000/api/v1/memories/search/text");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("test-key");
      const parsedBody = JSON.parse(String(init?.body ?? "{}"));
      expect(parsedBody).toEqual({
        query: "用户偏好",
        agent_id: "hub-main",
        match_threshold: 0.42,
        match_count: 5,
      });
      return new Response(
        JSON.stringify([
          {
            id: "m-1",
            content: "用户喜欢简洁回答",
            similarity: 0.81,
          },
          {
            id: "m-2",
            content: "喜欢列表格式",
            score: 0.77,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      query: { maxResults: 8, minScore: 0.35 },
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        agentIdMap: { main: "hub-main" },
      },
    });

    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    const results = await manager.search("用户偏好", {
      maxResults: 5,
      minScore: 0.42,
    });

    expect(results).toEqual([
      {
        path: "memory-hub://main/m-1",
        startLine: 1,
        endLine: 1,
        score: 0.81,
        snippet: "用户喜欢简洁回答",
        source: "memory",
        citation: "memory-hub:m-1",
      },
      {
        path: "memory-hub://main/m-2",
        startLine: 1,
        endLine: 1,
        score: 0.77,
        snippet: "喜欢列表格式",
        source: "memory",
        citation: "memory-hub:m-2",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads memory details by memory-hub path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-1?request_agent_id=main&visibility=auto",
      );
      return new Response(JSON.stringify({ id: "m-1", content: "完整内容" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    const read = await manager.readFile({ relPath: "memory-hub://main/m-1" });
    expect(read).toEqual({
      path: "memory-hub://main/m-1",
      text: "完整内容",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors configured read visibility when reading memory details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-3?request_agent_id=hub-main&visibility=shared",
      );
      return new Response(JSON.stringify({ id: "m-3", content: "shared内容" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        readVisibility: "shared",
        agentIdMap: { main: "hub-main" },
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    const read = await manager.readFile({ relPath: "memory-hub://main/m-3" });
    expect(read).toEqual({
      path: "memory-hub://main/m-3",
      text: "shared内容",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses YAML readVisibility when config does not set it", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-read-${Date.now()}-1`;
    const yamlPath = `${tmpRoot}/config/memory-hub.yml`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      yamlPath,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: shared",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-yaml?request_agent_id=main&visibility=shared",
        );
        return new Response(JSON.stringify({ id: "m-yaml", content: "yaml read" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
      await manager.readFile({ relPath: "memory-hub://main/m-yaml" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers config readVisibility over YAML value", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-yaml-read-${Date.now()}-2`;
    const yamlPath = `${tmpRoot}/config/memory-hub.yml`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      yamlPath,
      [
        "memoryHub:",
        "  baseUrl: http://localhost:8000/api/v1",
        "  apiKey: test-key",
        "  readVisibility: shared",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-override?request_agent_id=main&visibility=private",
        );
        return new Response(JSON.stringify({ id: "m-override", content: "override" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const cfg = createConfig({
        memoryHub: {
          readVisibility: "private",
        },
      });
      const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
      await manager.readFile({ relPath: "memory-hub://main/m-override" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("resolves baseUrl and apiKey from environment variables", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("env-key");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig();
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    await manager.search("test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves visibility from environment variables", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("shared");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-env?request_agent_id=main&visibility=shared",
      );
      return new Response(JSON.stringify({ id: "m-env", content: "env read" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
    await manager.search("env visibility", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-env" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes valid visibility values from config", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("shared");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-normalized-config?request_agent_id=main&visibility=auto",
      );
      return new Response(JSON.stringify({ id: "m-normalized-config", content: "normalized" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const configWithMixedCase = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              baseUrl: "http://localhost:8000/api/v1",
              apiKey: "test-key",
              readVisibility: " AUTO ",
              searchVisibility: " Shared ",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const manager = await MemoryHubSearchManager.create({
      cfg: configWithMixedCase,
      agentId: "main",
    });
    await manager.search("normalized config visibility", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-normalized-config" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prefers normalized config visibility values over YAML and env", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-normalize-priority-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: shared", "  searchVisibility: private"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/memories/search/batch")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          expect(parsedBody.queries[0].visibility).toBe("shared");
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                succeeded: 1,
                failed: 0,
                partial_success: false,
                results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(url).toBe(
          "http://localhost:8000/api/v1/memories/m-config-priority?request_agent_id=main&visibility=auto",
        );
        return new Response(
          JSON.stringify({ id: "m-config-priority", content: "config priority" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const configWithMixedCase = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: " AUTO ",
                searchVisibility: " Shared ",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const manager = await MemoryHubSearchManager.create({
        cfg: configWithMixedCase,
        agentId: "main",
      });
      await manager.search("config normalized priority", { maxResults: 2 });
      await manager.readFile({ relPath: "memory-hub://main/m-config-priority" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility environment variables", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";
    process.env.MEMORY_HUB_READ_VISIBILITY = "invalid";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "invalid";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("private");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-invalid-env?request_agent_id=main&visibility=auto",
      );
      return new Response(JSON.stringify({ id: "m-invalid-env", content: "env read" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = await MemoryHubSearchManager.create({ cfg: createConfig(), agentId: "main" });
    await manager.search("invalid env visibility", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-invalid-env" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid visibility values from config and falls back to env", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("shared");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-invalid-config?request_agent_id=main&visibility=shared",
      );
      return new Response(JSON.stringify({ id: "m-invalid-config", content: "config read" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const invalidConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              readVisibility: "invalid",
              searchVisibility: "invalid",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const manager = await MemoryHubSearchManager.create({ cfg: invalidConfig, agentId: "main" });
    await manager.search("invalid config visibility", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-invalid-config" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid visibility values from config and falls back to defaults", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("private");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-invalid-config-default?request_agent_id=main&visibility=auto",
      );
      return new Response(
        JSON.stringify({ id: "m-invalid-config-default", content: "config default" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const invalidConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              readVisibility: "invalid",
              searchVisibility: "invalid",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const manager = await MemoryHubSearchManager.create({ cfg: invalidConfig, agentId: "main" });
    await manager.search("invalid config defaults", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-invalid-config-default" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors config visibility over environment variables", async () => {
    process.env.MEMORY_HUB_BASE_URL = "http://localhost:8000/api/v1";
    process.env.MEMORY_HUB_API_KEY = "env-key";
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/search/batch")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.queries[0].visibility).toBe("private");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total: 1,
              succeeded: 1,
              failed: 0,
              partial_success: false,
              results: [{ index: 0, success: true, data: { count: 0, items: [] } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(url).toBe(
        "http://localhost:8000/api/v1/memories/m-env-override?request_agent_id=main&visibility=private",
      );
      return new Response(JSON.stringify({ id: "m-env-override", content: "override" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        readVisibility: "private",
        searchVisibility: "private",
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    await manager.search("env override", { maxResults: 2 });
    await manager.readFile({ relPath: "memory-hub://main/m-env-override" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable embedding probe when health endpoint is down", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    const result = await manager.probeEmbeddingAvailability();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("syncs session files via batch endpoint", async () => {
    const sessionFile = `/tmp/memory-hub-sync-${Date.now()}-1.jsonl`;
    await writeFile(sessionFile, "session body", "utf8");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:8000/api/v1/memories/batch");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        agent_id: "550e8400-e29b-41d4-a716-446655440000",
        content: "session body",
        memory_type: "experience",
        auto_route: true,
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            total: 1,
            succeeded: 1,
            failed: 0,
            partial_success: false,
            results: [{ index: 0, success: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        agentIdMap: { main: "550e8400-e29b-41d4-a716-446655440000" },
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    await manager.sync({ sessionFiles: [sessionFile] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await rm(sessionFile, { force: true });
  });

  it("falls back to single writes when batch request fails", async () => {
    const sessionFile = `/tmp/memory-hub-sync-${Date.now()}-2.jsonl`;
    await writeFile(sessionFile, "session body", "utf8");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/memories/batch")) {
        return new Response("boom", { status: 500 });
      }
      expect(url).toBe("http://localhost:8000/api/v1/memories");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body).toMatchObject({
        agent_id: "550e8400-e29b-41d4-a716-446655440000",
        content: "session body",
      });
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        agentIdMap: { main: "550e8400-e29b-41d4-a716-446655440000" },
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    await manager.sync({ sessionFiles: [sessionFile] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toContain("/memories/batch");
    expect(fetchMock.mock.calls[1]?.[0].toString()).toContain("/memories");
    await rm(sessionFile, { force: true });
  });

  it("reports status metadata for memory-hub provider", async () => {
    const cfg = createConfig({
      query: { maxResults: 9, minScore: 0.4 },
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        timeout: 4321,
      },
    });

    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });
    const status = manager.status();
    expect(status.backend).toBe("builtin");
    expect(status.provider).toBe("memory-hub");
    expect(status.model).toBe("remote");
    expect(status.requestedProvider).toBe("memory-hub");
    expect(status.custom?.remote).toEqual({
      baseUrl: "http://localhost:8000/api/v1",
      timeoutMs: 4321,
      healthEndpoint: "http://localhost:8000/api/v1/health",
      readVisibility: "auto",
      searchVisibility: "private",
    });
  });

  it("returns operation-specific timeout message for search", async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error("aborted");
      (error as Error & { name: string }).name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
        timeoutMs: 1234,
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    await expect(manager.search("timeout test")).rejects.toThrow(
      "memory-hub search timed out after 1234ms (POST /memories/search/batch)",
    );
  });

  it("truncates long HTTP error body in message", async () => {
    const fetchMock = vi.fn(async () => {
      const longBody = "x".repeat(500);
      return new Response(longBody, { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = createConfig({
      memoryHub: {
        baseUrl: "http://localhost:8000/api/v1",
        apiKey: "test-key",
      },
    });
    const manager = await MemoryHubSearchManager.create({ cfg, agentId: "main" });

    await expect(manager.search("bad request")).rejects.toThrow(
      /memory-hub request failed: HTTP 400 x+/,
    );

    await manager.search("bad request").catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message.length).toBeLessThanOrEqual(340);
    });
  });
});
