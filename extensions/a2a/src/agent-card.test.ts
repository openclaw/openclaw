/**
 * Tests for A2A Agent Card builder.
 */
import { describe, it, expect } from "vitest";
import { buildAgentCard } from "./agent-card.js";

describe("buildAgentCard", () => {
  it("builds a card with single agent", () => {
    const card = buildAgentCard({
      agents: [{ id: "main", description: "Main assistant" }],
      gatewayUrl: "https://openclaw.example.com",
    });

    expect(card.name).toBe("OpenClaw");
    expect(card.url).toBe("https://openclaw.example.com");
    expect(card.version).toBe("2026.7.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("main");
    expect(card.skills[0].name).toBe("main");
    expect(card.skills[0].description).toBe("Main assistant");
    expect(card.skills[0].tags).toEqual(["openclaw"]);
    expect(card.agents).toEqual(["main"]);
  });

  it("builds a card with multiple agents", () => {
    const card = buildAgentCard({
      agents: [
        { id: "main", description: "Primary" },
        { id: "researcher", description: "Deep research" },
        { id: "coder" },
      ],
      gatewayUrl: "http://localhost:18789",
    });

    expect(card.skills).toHaveLength(3);
    expect(card.skills[0].id).toBe("main");
    expect(card.skills[1].id).toBe("researcher");
    expect(card.skills[2].id).toBe("coder");
    expect(card.skills[2].description).toBeUndefined();
    expect(card.agents).toEqual(["main", "researcher", "coder"]);
  });

  it("handles empty agent list", () => {
    const card = buildAgentCard({
      agents: [],
      gatewayUrl: "http://localhost:18789",
    });

    expect(card.skills).toHaveLength(0);
    expect(card.agents).toEqual([]);
  });
});
