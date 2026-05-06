import { describe, expect, it } from "vitest";
import { IsolationIdentityError, resolveIsolationIdentity } from "./isolation-identity.js";

const cfgWith = (isolation?: Record<string, unknown>) =>
  ({
    memory: { isolation },
  }) as unknown as Parameters<typeof resolveIsolationIdentity>[0]["cfg"];

describe("resolveIsolationIdentity", () => {
  it("returns undefined when isolation is disabled", () => {
    const result = resolveIsolationIdentity({
      cfg: cfgWith({ enabled: false }),
      agentId: "agent1",
      sessionKey: "agent:agent1:direct:alice:c1",
      senderId: "alice",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when memory config is missing entirely", () => {
    const result = resolveIsolationIdentity({
      cfg: {} as never,
      agentId: "agent1",
      sessionKey: "agent:agent1:direct:alice:c1",
      senderId: "alice",
    });
    expect(result).toBeUndefined();
  });

  it("prefers explicit senderId when isolation enabled", () => {
    const result = resolveIsolationIdentity({
      cfg: cfgWith({ enabled: true }),
      agentId: "agent1",
      sessionKey: "agent:agent1:direct:bob:c1",
      senderId: "alice",
    });
    expect(result).toBe("alice");
  });

  it("falls back to direct-DM userId extracted from session key", () => {
    const result = resolveIsolationIdentity({
      cfg: cfgWith({ enabled: true }),
      agentId: "agent1",
      sessionKey: "agent:agent1:direct:bob:c1",
    });
    expect(result).toBe("bob");
  });

  it("throws when no identity resolvable and fallbackPolicy='deny' (default)", () => {
    expect(() =>
      resolveIsolationIdentity({
        cfg: cfgWith({ enabled: true }),
        agentId: "agent1",
        sessionKey: "agent:agent1:channel:discord:42",
      }),
    ).toThrow(IsolationIdentityError);
  });

  it("falls back to session-derived identity when policy='session'", () => {
    const result = resolveIsolationIdentity({
      cfg: cfgWith({ enabled: true, fallbackPolicy: "session" }),
      agentId: "agent1",
      sessionKey: "agent:agent1:channel:discord:42",
    });
    expect(result).toBe("session:agent:agent1:channel:discord:42");
  });

  it("falls back to agent identity when policy='agent'", () => {
    const result = resolveIsolationIdentity({
      cfg: cfgWith({ enabled: true, fallbackPolicy: "agent" }),
      agentId: "agent1",
      sessionKey: "agent:agent1:channel:discord:42",
    });
    expect(result).toBe("agent:agent1");
  });

  it("treats fallbackPolicy='deny' as the default when omitted", () => {
    expect(() =>
      resolveIsolationIdentity({
        cfg: cfgWith({ enabled: true }),
        agentId: "agent1",
        sessionKey: "agent:agent1:group:slack:T123",
      }),
    ).toThrow(IsolationIdentityError);
  });

  it("treats undefined senderId as missing (does not stringify)", () => {
    expect(() =>
      resolveIsolationIdentity({
        cfg: cfgWith({ enabled: true }),
        agentId: "agent1",
        sessionKey: "agent:agent1:channel:discord:42",
        senderId: undefined,
      }),
    ).toThrow(IsolationIdentityError);
  });

  it("rejects empty-string senderId as missing identity", () => {
    expect(() =>
      resolveIsolationIdentity({
        cfg: cfgWith({ enabled: true }),
        agentId: "agent1",
        sessionKey: "agent:agent1:channel:discord:42",
        senderId: "",
      }),
    ).toThrow(IsolationIdentityError);
  });
});
