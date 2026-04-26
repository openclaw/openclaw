import { describe, expect, it } from "vitest";
import { buildEnvelope, EnvelopeCache, type Envelope } from "./envelope.js";

describe("buildEnvelope", () => {
  it("propagates resolution fields and derives context_type from sessionKey", () => {
    const env = buildEnvelope({
      resolution: {
        role: "owner",
        is_owner: true,
        user_id: "u-1",
        handle_display: "+15551234",
        conversation_id: "conv-1",
      },
      channel: "whatsapp",
      handle: "+15551234",
      sessionKey: "agent:main:main",
    });
    expect(env.sender_role).toBe("owner");
    expect(env.is_owner).toBe(true);
    expect(env.user_id).toBe("u-1");
    expect(env.handle_display).toBe("+15551234");
    expect(env.conversation_id).toBe("conv-1");
    expect(env.context_type).toBe("dm");
    expect(env.channel).toBe("whatsapp");
    expect(env.handle).toBe("+15551234");
    expect(env.session_key).toBe("agent:main:main");
    // resolved_at is ISO-8601 + parseable.
    expect(() => new Date(env.resolved_at).toISOString()).not.toThrow();
  });

  it("flips context_type to group for group session keys", () => {
    const env = buildEnvelope({
      resolution: { role: "group_member", is_owner: false },
      channel: "discord",
      handle: "user-7",
      sessionKey: "agent:main:discord:group:server-9",
    });
    expect(env.context_type).toBe("group");
  });

  it("falls back to stranger when role is empty (defense-in-depth)", () => {
    const env = buildEnvelope({
      resolution: { role: "", is_owner: false },
      channel: "x",
      handle: "y",
    });
    expect(env.sender_role).toBe("stranger");
  });
});

describe("EnvelopeCache", () => {
  const sample = (sessionKey: string): Envelope => ({
    sender_role: "owner",
    is_owner: true,
    context_type: "dm",
    channel: "whatsapp",
    handle: `+1${sessionKey.slice(0, 4)}`,
    session_key: sessionKey,
    resolved_at: new Date().toISOString(),
  });

  it("returns undefined for missing keys", () => {
    expect(new EnvelopeCache().get("none")).toBeUndefined();
  });

  it("round-trips a stored envelope", () => {
    const c = new EnvelopeCache();
    c.set("k1", sample("k1"));
    expect(c.get("k1")?.session_key).toBe("k1");
  });

  it("expires entries past the TTL", async () => {
    const c = new EnvelopeCache({ ttlMs: 5 });
    c.set("k1", sample("k1"));
    await new Promise((r) => setTimeout(r, 15));
    expect(c.get("k1")).toBeUndefined();
  });

  it("evicts oldest entry when over the size cap (LRU)", () => {
    const c = new EnvelopeCache({ maxEntries: 2 });
    c.set("a", sample("a"));
    c.set("b", sample("b"));
    c.set("c", sample("c")); // should evict "a"
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.size()).toBe(2);
  });

  it("a get() promotes the entry so it survives the next eviction", () => {
    const c = new EnvelopeCache({ maxEntries: 2 });
    c.set("a", sample("a"));
    c.set("b", sample("b"));
    c.get("a"); // promote a → b is now LRU
    c.set("c", sample("c")); // should evict "b" (the new LRU)
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    expect(c.get("c")).toBeDefined();
  });

  it("delete and clear behave as expected", () => {
    const c = new EnvelopeCache();
    c.set("a", sample("a"));
    c.delete("a");
    expect(c.get("a")).toBeUndefined();
    c.set("a", sample("a"));
    c.set("b", sample("b"));
    c.clear();
    expect(c.size()).toBe(0);
  });
});
