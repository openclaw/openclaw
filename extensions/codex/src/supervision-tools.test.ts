// Codex supervision compatibility tests lock writes to active-turn controls.
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAuthProfileSelection } from "./app-server/auth-profile-selection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

type CodexSupervisionToolsOptions = Parameters<typeof createCodexSupervisionTools>[0];
type TestOptions = Omit<
  CodexSupervisionToolsOptions,
  | "resolveAuthProfileId"
  | "resolveAuthProfileIdAtEffect"
  | "resolveRuntimeOptions"
  | "senderIsOwner"
> & { senderIsOwner?: boolean };

const auth = createCodexAuthProfileSelection(providerAuth);

function createTestSupervisionTools(options: TestOptions) {
  return createCodexSupervisionTools({
    senderIsOwner: true,
    ...options,
    resolveAuthProfileId: auth.resolveCodexAppServerAuthProfileIdForAgent,
    resolveAuthProfileIdAtEffect: auth.resolveCodexAppServerAuthProfileIdAtEffect,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
}

function configuredTools(supervision: unknown, options: Omit<TestOptions, "getPluginConfig"> = {}) {
  return createTestSupervisionTools({ getPluginConfig: () => ({ supervision }), ...options });
}

const LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

type RecordedRequest = { method: string; params?: unknown };
type EndpointRequest = NonNullable<CodexSupervisionToolsOptions["request"]>;
type EndpointRequestHandler = (...args: Parameters<EndpointRequest>) => unknown;

function createEndpointRequest(handler: EndpointRequestHandler): EndpointRequest {
  return async <T>(...args: Parameters<EndpointRequest>) => (await handler(...args)) as T;
}

function storedPages(page: () => unknown): EndpointRequest {
  return createEndpointRequest(async (_endpoint, method) => {
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null };
    }
    if (method !== "thread/list") {
      throw new Error(`unexpected method: ${method}`);
    }
    return page();
  });
}

function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

function createRequest(thread: Record<string, unknown>) {
  const calls: RecordedRequest[] = [];
  const request = createEndpointRequest(async (_endpoint, method, params) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/read") {
      return { thread };
    }
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  });
  return { calls, request };
}

function createTools(
  request: EndpointRequest,
  overrides: Partial<CodexSupervisionToolsOptions> = {},
) {
  return createTestSupervisionTools({
    getPluginConfig: () => ({
      supervision: { ...readPolicy, allowWriteControls: true },
    }),
    request,
    ...overrides,
  });
}

const idleThread = (id = "thread-1") => ({ id, status: { type: "idle" } });
const activeThread = () => ({
  id: "thread-1",
  status: { type: "active" },
  turns: [{ id: "turn-1", status: "inProgress" }],
});
const sessionParams = { endpoint_id: "local", thread_id: "thread-1" };
const readPolicy = { enabled: true, allowRawTranscripts: true };
const agentReadConfig = {
  appServer: { transport: "websocket", homeScope: "agent", url: "ws://127.0.0.1:4500" },
  supervision: readPolicy,
};
const agentConfig = (agentDir: string, order?: string[]) => ({
  agents: { entries: { main: { agentDir } } },
  ...(order ? { auth: { order: { openai: order } } } : {}),
});
function endpointConfig(
  command: string,
  policy: {
    enabled?: boolean;
    allowRawTranscripts?: boolean;
    allowWriteControls?: boolean;
  },
) {
  return {
    supervision: {
      enabled: true,
      ...policy,
      endpoints: [{ id: "primary", transport: "stdio-proxy", command }],
    },
  };
}

function expectListError(request: EndpointRequest, detail: string, params = {}) {
  return expect(
    toolByName(createTools(request), "codex_sessions_list").execute("list", params),
  ).resolves.toMatchObject({
    details: { sessions: [], errors: [{ endpointId: "local", ok: false, detail }] },
  });
}

function readSession(tools: ReturnType<typeof createCodexSupervisionTools>, params = {}) {
  return toolByName(tools, "codex_session_read").execute("read", { ...sessionParams, ...params });
}

function mutateDuringRead(
  mutate: () => void,
  options: Partial<CodexSupervisionToolsOptions>,
  thread: Record<string, unknown> = idleThread(),
) {
  const methods: string[] = [];
  const request = createEndpointRequest(async (_endpoint, method) => {
    methods.push(method);
    if (method !== "thread/read") {
      throw new Error(`unexpected method: ${method}`);
    }
    mutate();
    return { thread };
  });
  return { tools: createTools(request, options), methods };
}

describe("Codex supervision compatibility tools", () => {
  beforeEach(() => {
    requestCodexAppServerJsonMock.mockReset();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
  });

  it("keeps the legacy local endpoint alias on shared user-home stdio", async () => {
    const transports: Array<string | undefined> = [];
    const request = createEndpointRequest(async (endpoint) => {
      transports.push(endpoint.configured?.transport);
      return {};
    });
    const tools = configuredTools(
      { enabled: true },
      {
        env: { [LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV]: "local" },
        request,
      },
    );

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(transports).toEqual(["stdio-proxy"]);
  });

  it.each([
    {
      name: "default shared user-home stdio",
      supervision: { enabled: true },
      expected: {
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    },
    {
      name: "shipped stdio endpoint working directory",
      supervision: {
        enabled: true,
        endpoints: [
          {
            id: "legacy-cwd",
            transport: "stdio-proxy",
            command: "codex",
            cwd: "/srv/codex-project",
          },
        ],
      },
      expected: {
        method: "thread/loaded/list",
        startOptions: expect.objectContaining({ transport: "stdio", cwd: "/srv/codex-project" }),
      },
    },
  ])("preserves $name", async ({ supervision, expected }) => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [], nextCursor: null });
    const tools = configuredTools(supervision, { env: {} });
    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});
    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("rejects unauthenticated remote compatibility endpoints before connecting", async () => {
    const tools = configuredTools(
      {
        enabled: true,
        allowRawTranscripts: true,
        endpoints: [
          { id: "remote", transport: "websocket", url: "wss://codex.example.com/app-server" },
        ],
      },
      { env: {} },
    );

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "remote",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("remote Codex app-server WebSocket URLs require");
  });

  it("retains the five shipped tool names and policy gates", async () => {
    const { request } = createRequest({ id: "thread-1", status: { type: "idle" } });
    const tools = configuredTools({ enabled: true }, { request });

    expect(tools.map((tool) => tool.name)).toEqual([
      "codex_endpoint_probe",
      "codex_sessions_list",
      "codex_session_read",
      "codex_session_send",
      "codex_session_interrupt",
    ]);
    await expect(
      toolByName(tools, "codex_session_read").execute("read", { thread_id: "thread-1" }),
    ).rejects.toThrow("Codex session reads are disabled");
    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
  });

  it("denies non-owner execution before reading endpoint or session data", async () => {
    const request = vi.fn();
    const tools = configuredTools({ enabled: true }, { senderIsOwner: false, request });

    await expect(toolByName(tools, "codex_sessions_list").execute("list", {})).rejects.toThrow(
      "require an owner-authorized sender",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves permitted list text and omits restricted fields (raw reads=%s)",
    async (allowRawTranscripts) => {
      const privatePreview = "API_TOKEN = computeToken()";
      const privateName = "Stored sk-abcdefghijklmnopqrstuv";
      const privateError = "private endpoint failure detail";
      const request = createEndpointRequest(async (endpoint, method) => {
        if (endpoint.id === "broken") {
          throw new Error(privateError);
        }
        if (method === "thread/loaded/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "thread/list") {
          return {
            data: [
              {
                id: "stored-thread",
                name: privateName,
                preview: privatePreview,
                status: { type: "idle" },
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const tools = configuredTools(
        {
          enabled: true,
          allowRawTranscripts,
          endpoints: [
            { id: "healthy", transport: "stdio-proxy" },
            { id: "broken", transport: "stdio-proxy" },
          ],
        },
        { request },
      );

      const result = await toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 1,
      });

      expect(result).toMatchObject({
        details: {
          sessions: [
            {
              endpointId: "healthy",
              threadId: "stored-thread",
              status: "idle",
              ...(allowRawTranscripts ? { name: privateName, preview: privatePreview } : {}),
            },
          ],
          errors: [
            {
              endpointId: "broken",
              ok: false,
              ...(allowRawTranscripts ? { detail: privateError } : {}),
            },
          ],
        },
      });
      const serialized = JSON.stringify(result);
      for (const text of [privatePreview, privateName, privateError]) {
        if (allowRawTranscripts) {
          expect(serialized).toContain(text);
        } else {
          expect(serialized).not.toContain(text);
        }
      }
    },
  );

  it("preserves raw tool arguments and output in permitted transcript reads", async () => {
    const output = "API_TOKEN = computeToken()\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuv\n";
    const thread = {
      id: "thread-1",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "dynamicToolCall",
              id: "call-read",
              tool: "read",
              arguments: { path: ".env", apiToken: "sk-abcdefghijklmnopqrstuv" },
              status: "completed",
              contentItems: [{ type: "inputText", text: output }],
              success: true,
            },
          ],
        },
      ],
    };
    const { request } = createRequest(thread);
    const result = await readSession(createTools(request), { include_turns: true });
    const expected = { summary: "codex session: thread-1", response: { thread } };
    expect(result.details).toEqual(expected);
    const text = result.content.find((part) => part.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text") {
      expect(JSON.parse(text.text)).toEqual(expected);
    }
  });

  it("stops loaded-session pagination when Codex cycles through prior cursors", async () => {
    let pageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      pageCalls += 1;
      if (pageCalls > 3) {
        throw new Error("unexpected fourth loaded-session page");
      }
      const nextCursor = ["loaded-page-a", "loaded-page-b", "loaded-page-a"][pageCalls - 1];
      return { data: [], nextCursor };
    });
    await expectListError(
      request,
      "Codex thread/loaded/list returned repeated cursor loaded-page-a",
    );
    expect(pageCalls).toBe(3);
  });

  it("fails closed at the loaded-session page cap when a cursor remains", async () => {
    let loadedPageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/read") {
        return { thread: idleThread("loaded-thread") };
      }
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      loadedPageCalls += 1;
      return {
        data: loadedPageCalls === 1 ? ["loaded-thread"] : [],
        nextCursor: `loaded-page-${loadedPageCalls + 1}`,
      };
    });
    await expectListError(
      request,
      "Codex thread/loaded/list exceeded 100 pages with a continuation cursor",
    );
    expect(loadedPageCalls).toBe(100);
  });

  it("rejects an over-returned loaded page before reading any thread", async () => {
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      return {
        data: Array.from({ length: 101 }, (_, index) => `thread-${index}`),
        nextCursor: null,
      };
    });
    await expectListError(request, "Codex thread/loaded/list returned more than 100 entries");
    expect(methods).toEqual(["thread/loaded/list"]);
  });

  it.each([
    ["non-string thread id", { data: [42], nextCursor: null }, "thread id at data[0]"],
    ["non-string cursor", { data: [], nextCursor: 42 }, "nextCursor"],
    ["oversized cursor", { data: [], nextCursor: "x".repeat(4097) }, "nextCursor"],
  ])("rejects a loaded page with %s", async (_name, response, detail) => {
    const request = createEndpointRequest(async () => response);
    await expectListError(request, `Codex thread/loaded/list returned an invalid ${detail}`);
  });

  it("continues past a duplicate-only stored page when its cursor advances", async () => {
    let storedPageCalls = 0;
    const request = storedPages(() => {
      storedPageCalls += 1;
      if (storedPageCalls === 3) {
        return {
          data: [idleThread("stored-thread-2")],
          nextCursor: null,
        };
      }
      return {
        data: [idleThread("stored-thread-1")],
        nextCursor: `stored-page-${storedPageCalls + 1}`,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 2,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [
          { endpointId: "local", threadId: "stored-thread-1" },
          { endpointId: "local", threadId: "stored-thread-2" },
        ],
        errors: [],
      },
    });
    expect(storedPageCalls).toBe(3);
  });

  it("rejects a stored page that over-returns max_stored_sessions", async () => {
    const request = storedPages(() => {
      return {
        data: [1, 2, 3].map((id) => idleThread(`stored-thread-${id}`)),
        nextCursor: null,
      };
    });
    await expectListError(request, "Codex thread/list returned more than 1 entries", {
      include_stored: true,
      max_stored_sessions: 1,
    });
  });

  it.each([
    ["missing thread id", { data: [{}], nextCursor: null }, "thread id at data[0]"],
    ["blank cursor", { data: [], nextCursor: " " }, "nextCursor"],
  ])("rejects a stored page with %s", async (_name, response, detail) => {
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      return response;
    });
    await expectListError(request, `Codex thread/list returned an invalid ${detail}`, {
      include_stored: true,
    });
  });

  it.each([
    {
      name: "live supervision config",
      initial: { enabled: true },
      revoked: { enabled: false },
      error: "Codex supervision is disabled",
    },
    {
      name: "removed endpoint",
      initial: {
        enabled: true,
        endpoints: [{ id: "remote", transport: "stdio-proxy", command: "codex" }],
      },
      revoked: { enabled: true, endpoints: [] },
      error: "endpoint remote was removed or changed",
    },
  ])("rechecks $name before the next paginated request", async ({ initial, revoked, error }) => {
    let pluginConfig: unknown = { supervision: initial };
    let requestCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      requestCalls += 1;
      pluginConfig = { supervision: revoked };
      return { data: [], nextCursor: "next-page" };
    });
    const tools = createTools(request, { getPluginConfig: () => pluginConfig });

    await expect(toolByName(tools, "codex_sessions_list").execute("list", {})).rejects.toThrow(
      error,
    );
    expect(requestCalls).toBe(1);
  });

  it("rechecks raw-transcript policy before a fallback transcript request", async () => {
    let pluginConfig: unknown = {
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    let requestCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      requestCalls += 1;
      pluginConfig = { supervision: { enabled: true, allowRawTranscripts: false } };
      throw new Error("turns not materialized yet");
    });
    const tools = createTools(request, { getPluginConfig: () => pluginConfig });

    await expect(readSession(tools, { include_turns: true })).rejects.toThrow(
      "Codex session reads are disabled",
    );
    expect(requestCalls).toBe(1);
  });

  it.each([
    {
      name: "returning a transcript",
      toolName: "codex_session_read",
      policy: readPolicy,
      thread: { ...idleThread(), turns: [{ id: "private-turn" }] },
      params: { include_turns: true },
    },
    {
      name: "mutating an active turn",
      toolName: "codex_session_send",
      policy: { allowWriteControls: true },
      thread: activeThread(),
      params: { text: "continue" },
    },
  ])("rejects an endpoint repoint before $name", async ({ toolName, policy, thread, params }) => {
    let pluginConfig: unknown = endpointConfig("codex-a", policy);
    const { tools, methods } = mutateDuringRead(
      () => {
        pluginConfig = endpointConfig("codex-b", policy);
      },
      { getPluginConfig: () => pluginConfig },
      thread,
    );

    await expect(
      toolByName(tools, toolName).execute("repoint", {
        ...sessionParams,
        endpoint_id: "primary",
        ...params,
      }),
    ).rejects.toThrow("endpoint primary was removed or changed");
    expect(methods).toEqual(["thread/read"]);
  });

  it("does not return a transcript when the effective agent directory changes in flight", async () => {
    let runtimeConfig = agentConfig("/tmp/codex-supervision-agent-a");
    const { tools } = mutateDuringRead(
      () => {
        runtimeConfig = agentConfig("/tmp/codex-supervision-agent-b");
      },
      {
        getPluginConfig: () => agentReadConfig,
        getRuntimeConfig: () => runtimeConfig,
      },
    );

    await expect(readSession(tools)).rejects.toThrow("endpoint local was removed or changed");
  });

  it("does not return a transcript when the effective auth profile changes in flight", async () => {
    const agentDir = "/tmp/codex-supervision-auth-agent";
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: Object.fromEntries(
            ["first", "second"].map((id) => [
              `openai:${id}`,
              {
                type: "oauth" as const,
                provider: "openai",
                access: `${id}-access`,
                refresh: `${id}-refresh`,
                expires: Date.now() + 60_000,
              },
            ]),
          ),
        },
      },
    ]);
    let runtimeConfig = agentConfig(agentDir, ["openai:first", "openai:second"]);
    const { tools } = mutateDuringRead(
      () => {
        runtimeConfig = agentConfig(agentDir, ["openai:second", "openai:first"]);
      },
      {
        getPluginConfig: () => agentReadConfig,
        getRuntimeConfig: () => runtimeConfig,
      },
    );

    await expect(readSession(tools)).rejects.toThrow("endpoint local was removed or changed");
  });

  it("does not return a transcript when fallback API-key auth changes in flight", async () => {
    vi.stubEnv("OPENAI_API_KEY", "first-fallback-key");
    const { tools } = mutateDuringRead(
      () => {
        vi.stubEnv("OPENAI_API_KEY", "second-fallback-key");
      },
      { getPluginConfig: () => ({ supervision: readPolicy }) },
    );

    await expect(readSession(tools)).rejects.toThrow("endpoint local was removed or changed");
  });

  it("rechecks write policy before mutating an active turn", async () => {
    let pluginConfig: unknown = {
      supervision: { enabled: true, allowWriteControls: true },
    };
    const { tools, methods } = mutateDuringRead(
      () => {
        pluginConfig = { supervision: { enabled: true, allowWriteControls: false } };
      },
      { getPluginConfig: () => pluginConfig },
      activeThread(),
    );

    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        ...sessionParams,
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
    expect(methods).toEqual(["thread/read"]);
  });

  it("rejects explicit starts and idle auto sends without a mutating request", async () => {
    const { calls, request } = createRequest({ ...idleThread(), turns: [] });
    const tools = createTools(request);
    const send = toolByName(tools, "codex_session_send");

    await expect(
      send.execute("start", {
        ...sessionParams,
        text: "continue",
        mode: "start",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls).toEqual([]);

    await expect(send.execute("auto", { ...sessionParams, text: "continue" })).rejects.toThrow(
      "Continue it from Codex Sessions",
    );
    expect(calls.map((call) => call.method)).toEqual(["thread/read"]);
  });

  it("steers and interrupts only after a passive active-turn read", async () => {
    const { calls, request } = createRequest(activeThread());
    const tools = createTools(request);
    const readCall = {
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: true },
    };

    await toolByName(tools, "codex_session_send").execute("steer", {
      ...sessionParams,
      text: "focus on the failing test",
      mode: "steer",
    });
    await toolByName(tools, "codex_session_interrupt").execute("interrupt", sessionParams);

    expect(calls).toEqual([
      readCall,
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [
            {
              type: "text",
              text: "focus on the failing test",
              text_elements: [],
            },
          ],
        },
      },
      readCall,
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  });
});
