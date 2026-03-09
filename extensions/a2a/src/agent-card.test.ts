import { describe, expect, it } from "vitest";
import { buildAgentCard, A2A_PROTOCOL_VERSION, AGENT_CARD_PATHS } from "./agent-card.js";
import type { A2APluginConfig } from "./config.js";

function createConfig(overrides?: Partial<A2APluginConfig>): A2APluginConfig {
  return {
    enabled: true,
    card: {
      name: "Test Agent",
      description: "A test A2A agent",
      version: "1.0.0",
      skills: [{ id: "chat", name: "Chat", description: "General chat" }],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    },
    auth: { mode: "none" },
    routing: { defaultAgentId: "default" },
    peers: [],
    timeouts: { agentResponseMs: 300_000, taskRetentionMs: 86_400_000 },
    ...overrides,
  };
}

describe("AGENT_CARD_PATHS", () => {
  it("includes v0.3.0 standard path", () => {
    expect(AGENT_CARD_PATHS).toContain("/.well-known/agent-card.json");
  });

  it("includes legacy v0.2.x alias", () => {
    expect(AGENT_CARD_PATHS).toContain("/.well-known/agent.json");
  });
});

describe("A2A_PROTOCOL_VERSION", () => {
  it("is 0.3.0", () => {
    expect(A2A_PROTOCOL_VERSION).toBe("0.3.0");
  });
});

describe("buildAgentCard", () => {
  it("builds a valid Agent Card with correct fields", () => {
    const cfg = createConfig();
    const card = buildAgentCard(cfg, "http://127.0.0.1:18789");

    expect(card.name).toBe("Test Agent");
    expect(card.description).toBe("A test A2A agent");
    expect(card.version).toBe("1.0.0");
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toBe("http://127.0.0.1:18789/a2a/jsonrpc");
    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
  });

  it("strips trailing slashes from gateway URL", () => {
    const card = buildAgentCard(createConfig(), "http://example.com:8080///");
    expect(card.url).toBe("http://example.com:8080/a2a/jsonrpc");
  });

  it("maps skills correctly", () => {
    const cfg = createConfig({
      card: {
        ...createConfig().card,
        skills: [
          { id: "search", name: "Search", description: "Web search", tags: ["search"] },
          { id: "code", name: "Code", description: "Code gen" },
        ],
      },
    });
    const card = buildAgentCard(cfg, "http://localhost:18789");

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]!.id).toBe("search");
    expect(card.skills[0]!.tags).toEqual(["search"]);
    expect(card.skills[1]!.id).toBe("code");
    expect(card.skills[1]!.tags).toEqual([]); // undefined → []
  });

  it("sets streaming capability to true", () => {
    const card = buildAgentCard(createConfig(), "http://localhost:18789");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("includes security schemes for bearer auth mode", () => {
    const cfg = createConfig({ auth: { mode: "bearer", token: "secret" } });
    const card = buildAgentCard(cfg, "http://localhost:18789");

    expect(card.securitySchemes).toBeDefined();
    expect(card.securitySchemes!.bearer).toBeDefined();
    expect(card.security).toEqual([{ bearer: [] }]);
  });

  it("omits security schemes for 'none' auth mode", () => {
    const cfg = createConfig({ auth: { mode: "none" } });
    const card = buildAgentCard(cfg, "http://localhost:18789");

    expect(card.securitySchemes).toBeUndefined();
    expect(card.security).toBeUndefined();
  });
});
