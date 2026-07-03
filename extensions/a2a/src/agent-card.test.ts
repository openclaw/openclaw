/**
 * Tests for A2A Agent Card builder.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildAgentCard } from "./agent-card.js";

describe("buildAgentCard", () => {
  it("builds a card with single agent", () => {
    const card = buildAgentCard({
      agents: [{ id: "main", description: "Main assistant" }],
      gatewayUrl: "https://openclaw.example.com",
    });

    assert.strictEqual(card.name, "OpenClaw");
    assert.strictEqual(card.url, "https://openclaw.example.com");
    assert.strictEqual(card.version, "2026.7.0");
    assert.strictEqual(card.capabilities.streaming, true);
    assert.strictEqual(card.capabilities.pushNotifications, false);
    assert.deepStrictEqual(card.defaultInputModes, ["text"]);
    assert.deepStrictEqual(card.defaultOutputModes, ["text"]);
    assert.strictEqual(card.skills.length, 1);
    assert.strictEqual(card.skills[0].id, "main");
    assert.strictEqual(card.skills[0].name, "main");
    assert.strictEqual(card.skills[0].description, "Main assistant");
    assert.deepStrictEqual(card.skills[0].tags, ["openclaw"]);
    assert.deepStrictEqual(card.agents, ["main"]);
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

    assert.strictEqual(card.skills.length, 3);
    assert.strictEqual(card.skills[0].id, "main");
    assert.strictEqual(card.skills[1].id, "researcher");
    assert.strictEqual(card.skills[2].id, "coder");
    assert.strictEqual(card.skills[2].description, undefined);
    assert.deepStrictEqual(card.agents, ["main", "researcher", "coder"]);
  });

  it("handles empty agent list", () => {
    const card = buildAgentCard({
      agents: [],
      gatewayUrl: "http://localhost:18789",
    });

    assert.strictEqual(card.skills.length, 0);
    assert.deepStrictEqual(card.agents, []);
  });
});
