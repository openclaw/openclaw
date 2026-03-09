import { describe, expect, it } from "vitest";
import { parseA2AConfig } from "./config.js";

describe("parseA2AConfig", () => {
  it("returns defaults for empty input", () => {
    const cfg = parseA2AConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.card.name).toBe("OpenClaw Agent");
    expect(cfg.card.description).toBe("OpenClaw A2A-enabled agent");
    expect(cfg.card.version).toBe("1.0.0");
    expect(cfg.card.defaultInputModes).toEqual(["text"]);
    expect(cfg.card.defaultOutputModes).toEqual(["text"]);
    expect(cfg.auth.mode).toBe("bearer");
    expect(cfg.auth.token).toBeUndefined();
    expect(cfg.routing.defaultAgentId).toBe("default");
    expect(cfg.peers).toEqual([]);
    expect(cfg.timeouts.agentResponseMs).toBe(300_000);
    expect(cfg.timeouts.taskRetentionMs).toBe(86_400_000);
  });

  it("returns defaults for null/undefined/non-object input", () => {
    expect(parseA2AConfig(null).enabled).toBe(false);
    expect(parseA2AConfig(undefined).enabled).toBe(false);
    expect(parseA2AConfig("string").enabled).toBe(false);
    expect(parseA2AConfig(42).enabled).toBe(false);
    expect(parseA2AConfig([]).enabled).toBe(false);
  });

  it("parses enabled flag", () => {
    expect(parseA2AConfig({ enabled: true }).enabled).toBe(true);
    expect(parseA2AConfig({ enabled: false }).enabled).toBe(false);
    expect(parseA2AConfig({ enabled: "yes" }).enabled).toBe(false); // non-boolean
  });

  it("parses card fields", () => {
    const cfg = parseA2AConfig({
      card: {
        name: "My Agent",
        description: "A test agent",
        version: "2.0.0",
        defaultInputModes: ["text", "file"],
        defaultOutputModes: ["data"],
      },
    });
    expect(cfg.card.name).toBe("My Agent");
    expect(cfg.card.description).toBe("A test agent");
    expect(cfg.card.version).toBe("2.0.0");
    expect(cfg.card.defaultInputModes).toEqual(["text", "file"]);
    expect(cfg.card.defaultOutputModes).toEqual(["data"]);
  });

  it("provides default skill when none specified", () => {
    const cfg = parseA2AConfig({});
    expect(cfg.card.skills).toEqual([
      { id: "chat", name: "Chat", description: "General-purpose chat" },
    ]);
  });

  it("parses custom skills", () => {
    const cfg = parseA2AConfig({
      card: {
        skills: [
          { id: "search", name: "Search", description: "Web search", tags: ["search", "web"] },
          { id: "code", name: "Code", description: "Code generation" },
        ],
      },
    });
    expect(cfg.card.skills).toHaveLength(2);
    expect(cfg.card.skills[0]!.id).toBe("search");
    expect(cfg.card.skills[0]!.tags).toEqual(["search", "web"]);
    expect(cfg.card.skills[1]!.id).toBe("code");
    expect(cfg.card.skills[1]!.tags).toBeUndefined();
  });

  it("falls back to default skill for empty/invalid skills array", () => {
    expect(parseA2AConfig({ card: { skills: [] } }).card.skills).toHaveLength(1);
    expect(parseA2AConfig({ card: { skills: [{}] } }).card.skills).toHaveLength(1);
    expect(parseA2AConfig({ card: { skills: "invalid" } }).card.skills).toHaveLength(1);
  });

  it("parses auth mode 'none'", () => {
    const cfg = parseA2AConfig({ auth: { mode: "none" } });
    expect(cfg.auth.mode).toBe("none");
  });

  it("defaults to bearer auth with no token", () => {
    const cfg = parseA2AConfig({});
    expect(cfg.auth.mode).toBe("bearer");
    expect(cfg.auth.token).toBeUndefined();
  });

  it("parses bearer auth with token", () => {
    const cfg = parseA2AConfig({ auth: { mode: "bearer", token: "secret123" } });
    expect(cfg.auth.mode).toBe("bearer");
    expect(cfg.auth.token).toBe("secret123");
  });

  it("trims whitespace from token", () => {
    const cfg = parseA2AConfig({ auth: { token: "  secret  " } });
    expect(cfg.auth.token).toBe("secret");
  });

  it("parses peers", () => {
    const cfg = parseA2AConfig({
      peers: [
        { name: "alice", agentCardUrl: "https://alice.example.com/.well-known/agent-card.json" },
        {
          name: "bob",
          agentCardUrl: "https://bob.example.com/.well-known/agent-card.json",
          auth: { type: "bearer", token: "bob-secret" },
        },
      ],
    });
    expect(cfg.peers).toHaveLength(2);
    expect(cfg.peers[0]!.name).toBe("alice");
    expect(cfg.peers[0]!.auth).toBeUndefined();
    expect(cfg.peers[1]!.name).toBe("bob");
    expect(cfg.peers[1]!.auth).toEqual({ type: "bearer", token: "bob-secret" });
  });

  it("skips peers with missing name or url", () => {
    const cfg = parseA2AConfig({
      peers: [
        { name: "", agentCardUrl: "https://example.com" },
        { name: "alice", agentCardUrl: "" },
        { name: "valid", agentCardUrl: "https://valid.com" },
        null,
        42,
      ],
    });
    expect(cfg.peers).toHaveLength(1);
    expect(cfg.peers[0]!.name).toBe("valid");
  });

  it("skips peer auth with invalid type", () => {
    const cfg = parseA2AConfig({
      peers: [
        {
          name: "test",
          agentCardUrl: "https://test.com",
          auth: { type: "apikey", token: "key" },
        },
      ],
    });
    expect(cfg.peers[0]!.auth).toBeUndefined();
  });

  it("parses routing config", () => {
    const cfg = parseA2AConfig({ routing: { defaultAgentId: "my-agent" } });
    expect(cfg.routing.defaultAgentId).toBe("my-agent");
  });

  it("parses timeout values", () => {
    const cfg = parseA2AConfig({
      timeouts: { agentResponseMs: 60_000, taskRetentionMs: 3_600_000 },
    });
    expect(cfg.timeouts.agentResponseMs).toBe(60_000);
    expect(cfg.timeouts.taskRetentionMs).toBe(3_600_000);
  });

  it("rejects negative timeout values", () => {
    const cfg = parseA2AConfig({
      timeouts: { agentResponseMs: -1, taskRetentionMs: -100 },
    });
    expect(cfg.timeouts.agentResponseMs).toBe(300_000); // default
    expect(cfg.timeouts.taskRetentionMs).toBe(86_400_000); // default
  });
});
