import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAgentCard, sendMessageToPeer, checkPeerHealth } from "./client.js";

// ── Mock fetch globally ──────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

const MOCK_AGENT_CARD = {
  name: "Remote Agent",
  description: "A remote A2A agent",
  version: "1.0.0",
  protocolVersion: "0.3.0",
  url: "https://remote.example.com/a2a/jsonrpc",
  skills: [{ id: "chat", name: "Chat", description: "Chat", tags: [] }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

// ── Tests: fetchAgentCard ────────────────────────────────────────────

describe("fetchAgentCard", () => {
  it("fetches and returns an Agent Card", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const card = await fetchAgentCard("https://remote.example.com/.well-known/agent-card.json");

    expect(card.name).toBe("Remote Agent");
    expect(card.protocolVersion).toBe("0.3.0");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("includes bearer token in request headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    await fetchAgentCard("https://remote.example.com/.well-known/agent-card.json", {
      type: "bearer",
      token: "my-secret",
    });

    const callArgs = mockFetch.mock.calls[0]!;
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret");
  });

  it("throws on non-200 response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    await expect(
      fetchAgentCard("https://not-found.example.com/.well-known/agent-card.json"),
    ).rejects.toThrow("Failed to fetch Agent Card");
  });
});

// ── Tests: sendMessageToPeer ─────────────────────────────────────────

describe("sendMessageToPeer", () => {
  const peer = {
    name: "test-peer",
    agentCardUrl: "https://remote.example.com/.well-known/agent-card.json",
  };

  it("sends a blocking message and returns reply", async () => {
    // First call: fetch Agent Card
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    // Second call: JSON-RPC message/send
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: {
          id: "task-123",
          status: {
            state: "completed",
            message: {
              kind: "message",
              messageId: "msg-1",
              role: "agent",
              parts: [{ kind: "text", text: "Hello from remote!" }],
            },
          },
        },
      }),
    );

    const result = await sendMessageToPeer({
      peer,
      message: "Hello!",
      blocking: true,
    });

    expect(result.status).toBe("completed");
    expect(result.taskId).toBe("task-123");
    expect(result.reply).toBe("Hello from remote!");
  });

  it("includes agent ID in message metadata", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: { id: "task-1", status: { state: "completed" } },
      }),
    );

    await sendMessageToPeer({
      peer,
      message: "test",
      agentId: "my-agent",
    });

    // Check the JSON-RPC body sent to the remote
    const sendCall = mockFetch.mock.calls[1]!;
    const body = JSON.parse(sendCall[1]?.body as string);
    expect(body.params.message.metadata).toEqual({ "openclaw.agentId": "my-agent" });
  });

  it("handles JSON-RPC error response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        error: { code: -32000, message: "Agent unavailable" },
      }),
    );

    const result = await sendMessageToPeer({ peer, message: "test" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("Agent unavailable");
  });

  it("handles missing task in response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const result = await sendMessageToPeer({ peer, message: "test" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("No task in response");
  });

  it("includes bearer auth in JSON-RPC request", async () => {
    const authPeer = {
      ...peer,
      auth: { type: "bearer" as const, token: "peer-secret" },
    };

    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: { id: "task-1", status: { state: "completed" } },
      }),
    );

    await sendMessageToPeer({ peer: authPeer, message: "test" });

    // Check auth header on the JSON-RPC call (second fetch)
    const sendCall = mockFetch.mock.calls[1]!;
    const headers = sendCall[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer peer-secret");
  });

  it("throws when Agent Card has no url", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...MOCK_AGENT_CARD, url: "" }));

    await expect(sendMessageToPeer({ peer, message: "test" })).rejects.toThrow("no url field");
  });

  it("extracts reply from artifacts when status message is empty", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: {
          id: "task-1",
          status: { state: "completed" },
          artifacts: [
            {
              parts: [{ kind: "text", text: "Artifact reply" }],
            },
          ],
        },
      }),
    );

    const result = await sendMessageToPeer({ peer, message: "test" });
    expect(result.reply).toBe("Artifact reply");
  });
});

// ── Tests: checkPeerHealth ───────────────────────────────────────────

describe("checkPeerHealth", () => {
  const peer = {
    name: "health-peer",
    agentCardUrl: "https://remote.example.com/.well-known/agent-card.json",
  };

  it("returns reachable with agent info on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const result = await checkPeerHealth(peer);

    expect(result.reachable).toBe(true);
    expect(result.name).toBe("health-peer");
    expect(result.agentName).toBe("Remote Agent");
    expect(result.protocolVersion).toBe("0.3.0");
    expect(result.streaming).toBe(true);
    expect(result.skills).toEqual(["Chat"]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns unreachable with error on failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await checkPeerHealth(peer);

    expect(result.reachable).toBe(false);
    expect(result.name).toBe("health-peer");
    expect(result.error).toContain("Connection refused");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns unreachable on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 503));

    const result = await checkPeerHealth(peer);

    expect(result.reachable).toBe(false);
    expect(result.error).toContain("503");
  });
});
