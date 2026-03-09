import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { A2APluginConfig } from "../config.js";
import { createA2ADiscoverTool, createA2ASendTool } from "./a2a-tools.js";

// ── Mock fetch ───────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

// ── Helpers ──────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<A2APluginConfig>): A2APluginConfig {
  return {
    enabled: true,
    card: {
      name: "Test",
      description: "Test",
      version: "1.0.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    },
    auth: { mode: "none" },
    routing: { defaultAgentId: "default" },
    peers: [
      {
        name: "alice",
        agentCardUrl: "https://alice.example.com/.well-known/agent-card.json",
      },
      {
        name: "bob",
        agentCardUrl: "https://bob.example.com/.well-known/agent-card.json",
        auth: { type: "bearer", token: "bob-token" },
      },
    ],
    timeouts: { agentResponseMs: 30_000, taskRetentionMs: 86_400_000 },
    ...overrides,
  };
}

const MOCK_AGENT_CARD = {
  name: "Remote Agent",
  description: "A remote agent",
  version: "1.0.0",
  protocolVersion: "0.3.0",
  url: "https://remote.example.com/a2a/jsonrpc",
  skills: [{ id: "chat", name: "Chat", description: "General chat", tags: [] }],
  capabilities: { streaming: false },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

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

const mockApi = {} as never;

// ── Tests: a2a_discover ──────────────────────────────────────────────

describe("a2a_discover tool", () => {
  it("has correct metadata", () => {
    const tool = createA2ADiscoverTool(createConfig());
    expect(tool.name).toBe("a2a_discover");
    expect(tool.description).toContain("Discover");
    expect(tool.description).toContain("alice");
    expect(tool.description).toContain("bob");
  });

  it("shows 'No peers configured' when peers is empty", () => {
    const tool = createA2ADiscoverTool(createConfig({ peers: [] }));
    expect(tool.description).toContain("No peers configured");
  });

  it("discovers a configured peer by name", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", { peer: "alice" });

    expect(result.details).toMatchObject({
      status: "ok",
      peer: "alice",
      agentCard: { name: "Remote Agent", protocolVersion: "0.3.0" },
    });

    // Verify the correct URL was called
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://alice.example.com/.well-known/agent-card.json",
    );
  });

  it("discovers a configured peer case-insensitively", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", { peer: "ALICE" });

    expect(result.details).toMatchObject({ status: "ok", peer: "alice" });
  });

  it("discovers a peer by raw URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", {
      peer: "https://new-agent.example.com/.well-known/agent-card.json",
    });

    expect(result.details).toMatchObject({ status: "ok" });
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://new-agent.example.com/.well-known/agent-card.json",
    );
  });

  it("auto-appends agent-card.json to base URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    await tool.execute("call-1", { peer: "http://192.168.1.10:18789" });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://192.168.1.10:18789/.well-known/agent-card.json",
    );
  });

  it("auto-appends agent-card.json and strips trailing slashes", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    await tool.execute("call-1", { peer: "http://example.com:8080///" });

    expect(mockFetch.mock.calls[0][0]).toBe("http://example.com:8080/.well-known/agent-card.json");
  });

  it("returns only selected fields from Agent Card", async () => {
    const fullCard = {
      ...MOCK_AGENT_CARD,
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
      signatures: [],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(fullCard));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", { peer: "alice" });
    const card = (result.details as { agentCard: Record<string, unknown> }).agentCard;

    // Should include selected fields
    expect(card.name).toBe("Remote Agent");
    expect(card.skills).toBeDefined();
    // Should not include security/internal fields
    expect(card).not.toHaveProperty("securitySchemes");
    expect(card).not.toHaveProperty("security");
    expect(card).not.toHaveProperty("url");
  });

  it("returns error on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", { peer: "alice" });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Connection refused",
    });
  });

  it("returns result in content format", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    const result = await tool.execute("call-1", { peer: "alice" });

    // Should have content array with text type
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Content text should be valid JSON
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
  });

  it("uses peer auth when available", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));

    const tool = createA2ADiscoverTool(createConfig());
    await tool.execute("call-1", { peer: "bob" });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bob-token");
  });
});

// ── Tests: a2a_send ──────────────────────────────────────────────────

describe("a2a_send tool", () => {
  it("has correct metadata", () => {
    const tool = createA2ASendTool(createConfig(), mockApi);
    expect(tool.name).toBe("a2a_send");
    expect(tool.description).toContain("Send a message");
    expect(tool.description).toContain("alice");
  });

  it("sends a message to a configured peer", async () => {
    // Agent Card fetch
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    // JSON-RPC message/send
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: {
          id: "task-42",
          status: {
            state: "completed",
            message: {
              kind: "message",
              messageId: "reply-1",
              role: "agent",
              parts: [{ kind: "text", text: "Got your message!" }],
            },
          },
        },
      }),
    );

    const tool = createA2ASendTool(createConfig(), mockApi);
    const result = await tool.execute("call-1", {
      peer: "alice",
      message: "Hello Alice!",
    });

    expect(result.details).toMatchObject({
      peer: "alice",
      status: "completed",
      taskId: "task-42",
      reply: "Got your message!",
    });
  });

  it("includes agentId in the request when provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: { id: "task-1", status: { state: "completed" } },
      }),
    );

    const tool = createA2ASendTool(createConfig(), mockApi);
    await tool.execute("call-1", {
      peer: "alice",
      message: "Hello",
      agentId: "special-agent",
    });

    // Check the JSON-RPC body
    const rpcBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(rpcBody.params.message.metadata).toEqual({
      "openclaw.agentId": "special-agent",
    });
  });

  it("returns error on send failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

    const tool = createA2ASendTool(createConfig(), mockApi);
    const result = await tool.execute("call-1", {
      peer: "alice",
      message: "Hello",
    });

    expect(result.details).toMatchObject({
      status: "error",
      peer: "alice",
      error: "Network timeout",
    });
  });

  it("sends to a raw URL peer", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: { id: "task-1", status: { state: "completed" } },
      }),
    );

    const tool = createA2ASendTool(createConfig(), mockApi);
    const result = await tool.execute("call-1", {
      peer: "http://192.168.1.50:18789",
      message: "Hello raw peer",
    });

    // Agent Card URL should have been auto-constructed
    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://192.168.1.50:18789/.well-known/agent-card.json",
    );
    expect(result.details).toMatchObject({ status: "completed" });
  });

  it("uses configured timeout", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_AGENT_CARD));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        result: { id: "task-1", status: { state: "completed" } },
      }),
    );

    const cfg = createConfig({
      timeouts: { agentResponseMs: 60_000, taskRetentionMs: 86_400_000 },
    });
    const tool = createA2ASendTool(cfg, mockApi);
    await tool.execute("call-1", { peer: "alice", message: "test" });

    // The send call (2nd fetch) should use blocking timeout
    const sendCallOpts = mockFetch.mock.calls[1][1];
    // AbortSignal.timeout is used internally by sendMessageToPeer
    expect(sendCallOpts.signal).toBeDefined();
  });

  it("has parameters schema with required fields", () => {
    const tool = createA2ASendTool(createConfig(), mockApi);
    const schema = tool.parameters;

    expect(schema.properties).toHaveProperty("peer");
    expect(schema.properties).toHaveProperty("message");
    expect(schema.properties).toHaveProperty("agentId");
    expect(schema.required).toContain("peer");
    expect(schema.required).toContain("message");
    // agentId should be optional
    expect(schema.required).not.toContain("agentId");
  });
});
