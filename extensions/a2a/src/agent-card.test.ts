import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { buildAgentCard } from "./agent-card.js";
import type { A2APluginConfig } from "./config.js";

function createMinimalConfig(): OpenClawConfig {
  return {};
}

function createConfigWithAgent(agentId: string, name?: string, identityName?: string): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: agentId,
          name,
          identity: identityName ? { name: identityName } : undefined,
        },
      ],
    },
  };
}

describe("buildAgentCard", () => {
  it("builds card with default name when no agent config", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.name).toBe("OpenClaw Agent (main)");
    expect(card.description).toBe("AI assistant powered by OpenClaw");
    expect(card.url).toBe("https://example.com/a2a");
    expect(card.protocolVersion).toBe("0.3.0");
  });

  it("uses agent identity name when available", () => {
    const config = createConfigWithAgent("main", "Agent Name", "Identity Name");
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.name).toBe("Identity Name");
  });

  it("uses agent name when identity name not available", () => {
    const config = createConfigWithAgent("main", "Agent Name");
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.name).toBe("Agent Name");
  });

  it("uses custom agent id from plugin config", () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", name: "Main Agent" },
          { id: "bot1", name: "Bot One" },
        ],
      },
    };
    const pluginConfig: A2APluginConfig = { enabled: true, agentId: "bot1" };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.name).toBe("Bot One");
  });

  it("uses custom description from plugin config", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = {
      enabled: true,
      description: "My custom assistant",
    };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.description).toBe("My custom assistant");
  });

  it("removes trailing slash from public URL", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com/",
    });

    expect(card.url).toBe("https://example.com/a2a");
  });

  it("sets correct capabilities", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
    });
  });

  it("includes assistant skill", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.skills).toBeDefined();
    expect(card.skills?.length).toBeGreaterThan(0);
    expect(card.skills?.[0].id).toBe("assistant");
  });

  it("sets correct input/output modes", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
  });

  it("does not include securitySchemes when auth not required", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
    });

    expect((card as Record<string, unknown>).securitySchemes).toBeUndefined();
    expect((card as Record<string, unknown>).security).toBeUndefined();
  });

  it("includes securitySchemes when authRequired is true", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
      authRequired: true,
    });

    const cardAny = card as Record<string, unknown>;
    expect(cardAny.securitySchemes).toEqual({
      a2aApiKey: {
        type: "apiKey",
        name: "Authorization",
        in: "header",
      },
    });
    expect(cardAny.security).toEqual([{ a2aApiKey: [] }]);
  });

  it("does not include securitySchemes when authRequired is false", () => {
    const config = createMinimalConfig();
    const pluginConfig: A2APluginConfig = { enabled: true };

    const card = buildAgentCard({
      config,
      pluginConfig,
      publicUrl: "https://example.com",
      authRequired: false,
    });

    expect((card as Record<string, unknown>).securitySchemes).toBeUndefined();
    expect((card as Record<string, unknown>).security).toBeUndefined();
  });
});
