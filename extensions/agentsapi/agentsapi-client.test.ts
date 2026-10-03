import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";

const { fetchWithSsrFGuardMock, releaseMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  releaseMock: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  fetchWithSsrFGuardMock.mockReset();
  releaseMock.mockClear();
});

describe("Agents API self-hosted session connection", () => {
  it("retains self-hosted metadata while waiting for the matching external executor", async () => {
    const environment = {
      type: "self_hosted",
      id: "environment-fixture",
      workspace_directory: "/fixture/workspace",
      remote_url: "wss://executor.invalid/session-fixture",
    };
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: Response.json({
        id: "session-fixture",
        status: "requires_action",
        error: null,
        environment,
        required_actions: [
          { type: "environment_connection", environment_id: "environment-fixture" },
          {
            type: "function_call",
            turn_id: "turn-fixture",
            call_id: "call-fixture",
            name: "fixture_tool",
            arguments: {},
          },
        ],
      }),
      finalUrl: "https://api.openai.com/v1/agents/sessions/session-fixture",
      release: releaseMock,
    }));
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
    const signal = new AbortController().signal;
    expect((await client.session("session-fixture", signal)).environment).toEqual(environment);
    expect(await client.pendingFunctionCalls("session-fixture", signal)).toEqual([
      {
        type: "function_call",
        turn_id: "turn-fixture",
        call_id: "call-fixture",
        name: "fixture_tool",
        arguments: {},
      },
    ]);
  });

  it.each([
    { type: "openai_hosted", requestedId: "environment-fixture" },
    { type: "self_hosted", requestedId: "foreign-environment" },
  ])(
    "rejects unsupported connection actions for $type/$requestedId",
    async ({ type, requestedId }) => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: Response.json({
          id: "session-fixture",
          status: "requires_action",
          error: null,
          environment: {
            type,
            id: "environment-fixture",
            workspace_directory: "/fixture/workspace",
            remote_url: "wss://executor.invalid/session-fixture",
          },
          required_actions: [{ type: "environment_connection", environment_id: requestedId }],
        }),
        finalUrl: "https://api.openai.com/v1/agents/sessions/session-fixture",
        release: releaseMock,
      });
      const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
      await expect(
        client.pendingFunctionCalls("session-fixture", new AbortController().signal),
      ).rejects.toThrow("cannot reconnect an environment_connection");
    },
  );
});

describe("Agents API session creation", () => {
  it("keeps Gateway functions and MCP tools when native search is disabled", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ id: "session-fixture" }),
      finalUrl: "https://api.openai.com/v1/agents/sessions",
      release: releaseMock,
    });
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
    const gatewayFunction = {
      type: "function" as const,
      name: "message",
      description: "Send a fixture message",
      parameters: {},
    };
    const mcpTool = {
      type: "mcp" as const,
      server_label: "fixture",
      transport: { type: "http" as const, server_url: "https://mcp.example.test" },
    };

    await client.create(new AbortController().signal, "Fixture instructions", "fixture-model", {
      nativeTools: [],
      functions: [gatewayFunction],
      mcpTools: [mcpTool],
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]![0];
    const body: unknown = await new Request(call.url, call.init).json();
    expect(body).toHaveProperty("agent.tools", [mcpTool, gatewayFunction]);
  });

  it("sends the selected model and OpenClaw attribution to the backend", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.9.1");
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      "User-Agent: fixture-client/1.0\nX-Attribution-Fixture: preserved",
    );
    const model = "future-model";
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ id: "session-fixture" }),
      finalUrl: "https://api.openai.com/v1/agents/sessions",
      release: releaseMock,
    });
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());

    await expect(
      client.create(new AbortController().signal, "Fixture instructions", model),
    ).resolves.toBe("session-fixture");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("Expected a session creation request");
    }
    const request = new Request(call.url, call.init);
    const body: unknown = await request.json();
    expect(request.method).toBe("POST");
    expect(request.headers.get("user-agent")).toBe("openclaw/2026.9.1");
    expect(request.headers.get("originator")).toBe("openclaw");
    expect(request.headers.get("version")).toBe("2026.9.1");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-not-a-real-api-key");
    expect(request.headers.get("x-stainless-lang")).toBe("js");
    expect(request.headers.get("x-attribution-fixture")).toBe("preserved");
    expect(body).toMatchObject({
      agent: { model },
    });
  });

  it("preserves the backend's unsupported-model error", async () => {
    const backendMessage = "Model 'future-model' is not supported by the Agents API.";
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ error: { message: backendMessage } }, { status: 400 }),
      finalUrl: "https://api.openai.com/v1/agents/sessions",
      release: releaseMock,
    });
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());

    await expect(
      client.create(new AbortController().signal, "Fixture instructions", "future-model"),
    ).rejects.toThrow(backendMessage);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });
});
