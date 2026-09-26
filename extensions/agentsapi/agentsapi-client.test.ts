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
