import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMemoriaPluginConfig } from "./config.js";
import plugin from "./index.js";

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type ToolLike = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{ details?: unknown }>;
};

type HookRecord = {
  name: string;
  handler: (...args: unknown[]) => Promise<unknown> | unknown;
};

type RegisteredToolRecord = {
  tool: unknown;
  opts?: { name?: string; names?: string[] };
};

function createMockApi(pluginConfig: Record<string, unknown>) {
  const registeredTools: RegisteredToolRecord[] = [];
  const hooks: HookRecord[] = [];

  const api = {
    id: "memory-memoria",
    name: "Memory (Memoria)",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: (tool: unknown, opts?: { name?: string; names?: string[] }) => {
      registeredTools.push({ tool, opts });
    },
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    resolvePath: (input: string) => input,
    on: (name: string, handler: HookRecord["handler"]) => {
      hooks.push({ name, handler });
    },
  };

  return { api, registeredTools, hooks };
}

function collectTools(records: RegisteredToolRecord[], ctx: ToolContext): ToolLike[] {
  const tools: ToolLike[] = [];

  for (const record of records) {
    if (typeof record.tool === "function") {
      const factoryResult = (
        record.tool as (toolContext: ToolContext) => unknown[] | unknown | null | undefined
      )(ctx);
      if (Array.isArray(factoryResult)) {
        for (const entry of factoryResult) {
          if (entry && typeof entry === "object" && "name" in entry) {
            tools.push(entry as ToolLike);
          }
        }
      } else if (factoryResult && typeof factoryResult === "object" && "name" in factoryResult) {
        tools.push(factoryResult as ToolLike);
      }
      continue;
    }

    if (record.tool && typeof record.tool === "object" && "name" in record.tool) {
      tools.push(record.tool as ToolLike);
    }
  }

  return tools;
}

function findTool(records: RegisteredToolRecord[], ctx: ToolContext, name: string): ToolLike {
  const tools = collectTools(records, ctx);
  const match = tools.find((tool) => tool.name === name);
  if (!match) {
    throw new Error(`Tool ${name} not found`);
  }
  return match;
}

function findHook(hooks: HookRecord[], name: string): HookRecord["handler"] {
  const hook = hooks.find((entry) => entry.name === name);
  if (!hook) {
    throw new Error(`Hook ${name} not found`);
  }
  return hook.handler;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory-memoria plugin", () => {
  it("parses config defaults", () => {
    const config = parseMemoriaPluginConfig({
      apiUrl: "http://127.0.0.1:8100",
    });

    expect(config.backend).toBe("http");
    expect(config.autoRecall).toBe(true);
    expect(config.retrieveTopK).toBe(5);
  });

  it("registers minimal core memory tools and hooks", () => {
    const { api, registeredTools, hooks } = createMockApi({
      backend: "http",
      apiUrl: "http://127.0.0.1:8100",
      autoRecall: true,
      autoObserve: true,
    });

    plugin.register(api as never);

    const tools = collectTools(registeredTools, { sessionKey: "s1" });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "memory_forget",
      "memory_get",
      "memory_list",
      "memory_recall",
      "memory_retrieve",
      "memory_search",
      "memory_stats",
      "memory_store",
    ]);

    expect(hooks.map((hook) => hook.name).sort()).toEqual(["agent_end", "before_prompt_build"]);
  });

  it("executes memory_search via HTTP backend", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify([
          {
            memory_id: "m-1",
            content: "User prefers concise answers",
            memory_type: "profile",
            confidence: 0.9,
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, registeredTools } = createMockApi({
      backend: "http",
      apiUrl: "http://127.0.0.1:8100",
      apiKey: "token",
      retrieveTopK: 5,
    });

    plugin.register(api as never);

    const tool = findTool(registeredTools, { sessionKey: "session-a" }, "memory_search");
    const result = await tool.execute("tc-1", { query: "user preferences" });

    const details = result.details as { count?: number; memories?: Array<{ memory_id: string }> };
    expect(details.count).toBe(1);
    expect(details.memories?.[0]?.memory_id).toBe("m-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls.at(0);
    expect(String(firstCall?.[0] ?? "")).toContain("/v1/memories/search");
  });

  it("injects guidance and auto-recall context in before_prompt_build", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memories/retrieve")) {
        return new Response(
          JSON.stringify([
            {
              memory_id: "m-2",
              content: "Call user Sam",
              memory_type: "profile",
              confidence: 0.8,
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, hooks } = createMockApi({
      backend: "http",
      apiUrl: "http://127.0.0.1:8100",
      autoRecall: true,
      retrieveTopK: 3,
    });

    plugin.register(api as never);

    const beforePromptBuild = findHook(hooks, "before_prompt_build");
    const result = (await beforePromptBuild(
      {
        prompt: "what do you remember about me?",
        messages: [],
      },
      {
        sessionKey: "session-b",
      },
    )) as {
      appendSystemContext?: string;
      prependContext?: string;
    };

    expect(result.appendSystemContext).toContain("Memoria is the durable external memory system");
    expect(result.prependContext).toContain("<relevant-memories>");
  });

  it("returns actionable error for embedded backend", async () => {
    const { api, registeredTools } = createMockApi({
      backend: "embedded",
      dbUrl: "mysql+pymysql://root:111@127.0.0.1:6001/memoria",
      pythonExecutable: "python3",
    });

    plugin.register(api as never);

    const tool = findTool(registeredTools, { sessionKey: "session-c" }, "memory_store");

    await expect(
      tool.execute("tc-embedded", {
        content: "Remember this",
      }),
    ).rejects.toThrow("embedded backend is not bootstrapped");
  });
});
