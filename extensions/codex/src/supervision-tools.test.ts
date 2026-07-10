// Codex supervision compatibility tests lock writes to active-turn controls.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexSupervisionTools,
  LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV,
  LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV,
  LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV,
  type CodexSupervisionToolsOptions,
} from "./supervision-tools.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

type RecordedRequest = { method: string; params?: unknown };

function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

function createRequest(thread: Record<string, unknown>) {
  const calls: RecordedRequest[] = [];
  const request: NonNullable<CodexSupervisionToolsOptions["request"]> = async <T>(
    _endpoint,
    method,
    params,
  ) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/read") {
      return { thread } as unknown as T;
    }
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null } as unknown as T;
    }
    return {} as unknown as T;
  };
  return { calls, request };
}

function createTools(
  request: NonNullable<CodexSupervisionToolsOptions["request"]>,
  overrides: Partial<CodexSupervisionToolsOptions> = {},
) {
  return createCodexSupervisionTools({
    getPluginConfig: () => ({
      supervision: {
        enabled: true,
        allowRawTranscripts: true,
        allowWriteControls: true,
      },
    }),
    request,
    ...overrides,
  });
}

describe("Codex supervision compatibility tools", () => {
  beforeEach(() => {
    requestCodexAppServerJsonMock.mockReset();
  });

  it("keeps the legacy local endpoint alias on shared user-home stdio", async () => {
    const transports: Array<string | undefined> = [];
    const request: NonNullable<CodexSupervisionToolsOptions["request"]> = async <T>(endpoint) => {
      transports.push(endpoint.configured?.transport);
      return {} as T;
    };
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      env: { [LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV]: "local" },
      request,
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(transports).toEqual(["stdio-proxy"]);
  });

  it("defaults the local compatibility endpoint to shared user-home stdio", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [], nextCursor: null });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      env: {},
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      }),
    );
  });

  it("preserves the shipped stdio endpoint working directory", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [], nextCursor: null });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
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
      }),
      env: {},
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/loaded/list",
        startOptions: expect.objectContaining({
          transport: "stdio",
          cwd: "/srv/codex-project",
        }),
      }),
    );
  });

  it("rejects unauthenticated remote compatibility endpoints before connecting", async () => {
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          allowRawTranscripts: true,
          endpoints: [
            { id: "remote", transport: "websocket", url: "wss://codex.example.com/app-server" },
          ],
        },
      }),
      env: {},
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "remote",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("remote Codex app-server WebSocket URLs require");
  });

  it("retains the five shipped tool names and policy gates", async () => {
    const { request } = createRequest({ id: "thread-1", status: { type: "idle" } });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      request,
    });

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

  it("rejects explicit starts and idle auto sends without a mutating request", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const tools = createTools(request);
    const send = toolByName(tools, "codex_session_send");

    await expect(
      send.execute("start", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
        mode: "start",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls).toEqual([]);

    await expect(
      send.execute("auto", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls.map((call) => call.method)).toEqual(["thread/read"]);
  });

  it("steers and interrupts only after a passive active-turn read", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "active" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    });
    const tools = createTools(request);

    await toolByName(tools, "codex_session_send").execute("steer", {
      endpoint_id: "local",
      thread_id: "thread-1",
      text: "focus on the failing test",
      mode: "steer",
    });
    await toolByName(tools, "codex_session_interrupt").execute("interrupt", {
      endpoint_id: "local",
      thread_id: "thread-1",
    });

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
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
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  });

  it("retains standalone MCP env aliases only behind the trusted adapter opt-in", async () => {
    const { request } = createRequest({
      id: "thread-1",
      status: { type: "active" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      env: {
        [LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV]: "1",
        [LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV]: "1",
      },
      request,
      useLegacyMcpPolicyEnv: true,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex session: thread-1" } });
    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex steer: turn-1" } });
  });
});
