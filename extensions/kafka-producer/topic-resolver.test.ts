import { describe, it, expect } from "vitest";
import { parseSessionKey, resolveTopic, resolveKey, type EventContext } from "./topic-resolver.js";

// --- parseSessionKey ---

describe("parseSessionKey", () => {
  it("parses a full session key", () => {
    const result = parseSessionKey("agent:compliance-bot:discord:acct_123:direct:user456");
    expect(result).toEqual({
      agentId: "compliance-bot",
      channel: "discord",
      accountId: "acct_123",
      peerKind: "direct",
      peerId: "user456",
    });
  });

  it("parses a main session key", () => {
    const result = parseSessionKey("agent:ops:main");
    expect(result).toEqual({
      agentId: "ops",
      channel: "main",
      accountId: null,
      peerKind: null,
      peerId: null,
    });
  });

  it("parses a group session key", () => {
    const result = parseSessionKey("agent:support-bot:telegram:acct_1:group:chat789");
    expect(result).toEqual({
      agentId: "support-bot",
      channel: "telegram",
      accountId: "acct_1",
      peerKind: "group",
      peerId: "chat789",
    });
  });

  it("parses a channel peer kind", () => {
    const result = parseSessionKey("agent:bot:discord:acct_1:channel:general");
    expect(result).toEqual({
      agentId: "bot",
      channel: "discord",
      accountId: "acct_1",
      peerKind: "channel",
      peerId: "general",
    });
  });

  it("parses a minimal agent key", () => {
    const result = parseSessionKey("agent:myagent");
    expect(result).toEqual({
      agentId: "myagent",
      channel: null,
      accountId: null,
      peerKind: null,
      peerId: null,
    });
  });

  it("parses key without peer info", () => {
    const result = parseSessionKey("agent:myagent:slack:acct_5");
    expect(result).toEqual({
      agentId: "myagent",
      channel: "slack",
      accountId: "acct_5",
      peerKind: null,
      peerId: null,
    });
  });

  it("handles peer ID with colons", () => {
    const result = parseSessionKey("agent:bot:discord:acct:direct:guild-123:channel-456");
    expect(result?.peerId).toBe("guild-123:channel-456");
  });

  it("returns null for non-agent keys", () => {
    expect(parseSessionKey("global")).toBeNull();
    expect(parseSessionKey("unknown")).toBeNull();
    expect(parseSessionKey("")).toBeNull();
    expect(parseSessionKey("subagent:abc:123")).toBeNull();
  });
});

// --- resolveTopic ---

function makeCtx(overrides: Partial<EventContext> = {}): EventContext {
  return {
    agentId: "compliance-bot",
    channel: "discord",
    accountId: "acct_123",
    peerKind: "direct",
    peerId: "user456",
    channelId: "discord",
    stream: "tool",
    runId: "run_001",
    sessionKey: "agent:compliance-bot:discord:acct_123:direct:user456",
    ...overrides,
  };
}

describe("resolveTopic", () => {
  const ctx = makeCtx();

  it("returns a static topic unchanged", () => {
    expect(resolveTopic("openclaw.events", ctx)).toBe("openclaw.events");
  });

  it("resolves {agentId}", () => {
    expect(resolveTopic("openclaw.{agentId}.events", ctx)).toBe("openclaw.compliance-bot.events");
  });

  it("resolves {channel}", () => {
    expect(resolveTopic("openclaw.{channel}.events", ctx)).toBe("openclaw.discord.events");
  });

  it("resolves {stream}", () => {
    expect(resolveTopic("openclaw.{agentId}.{stream}", ctx)).toBe("openclaw.compliance-bot.tool");
  });

  it("resolves multiple variables", () => {
    expect(resolveTopic("{agentId}.{channel}.{stream}", ctx)).toBe("compliance-bot.discord.tool");
  });

  it("resolves missing fields to 'unknown'", () => {
    const minCtx = makeCtx({ accountId: null });
    expect(resolveTopic("{agentId}.{accountId}", minCtx)).toBe("compliance-bot.unknown");
  });

  it("resolves unknown agentId to 'unknown'", () => {
    const ctx = makeCtx({ agentId: "unknown", channel: null });
    expect(resolveTopic("{agentId}.events", ctx)).toBe("unknown.events");
  });
});

// --- resolveKey ---

describe("resolveKey", () => {
  const ctx = makeCtx();

  it("returns null for null keyField", () => {
    expect(resolveKey(null, ctx)).toBeNull();
  });

  it("returns null for undefined keyField", () => {
    expect(resolveKey(undefined, ctx)).toBeNull();
  });

  it("resolves sessionKey", () => {
    expect(resolveKey("sessionKey", ctx)).toBe(
      "agent:compliance-bot:discord:acct_123:direct:user456",
    );
  });

  it("resolves agentId", () => {
    expect(resolveKey("agentId", ctx)).toBe("compliance-bot");
  });

  it("resolves channel", () => {
    expect(resolveKey("channel", ctx)).toBe("discord");
  });

  it("returns null for null-valued field", () => {
    const minCtx = makeCtx({ channel: null });
    expect(resolveKey("channel", minCtx)).toBeNull();
  });

  it("returns null for unknown field", () => {
    expect(resolveKey("nonexistent" as any, ctx)).toBeNull();
  });
});
