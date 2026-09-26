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
  it.each(["gpt-6-astra", "future-model"])(
    "sends the selected model %s to the backend",
    async (model) => {
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
      expect(body).toMatchObject({
        agent: { model, tools: [{ type: "web_search", mode: "live" }] },
      });
    },
  );

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
