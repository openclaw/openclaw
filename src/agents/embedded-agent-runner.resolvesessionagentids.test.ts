// Covers resolving the active agent id from session keys and explicit config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";

describe("resolveSessionAgentIds", () => {
  const cfg = {
    agents: {
      list: [{ id: "main" }, { id: "beta", default: true }],
    },
  } as OpenClawConfig;

  it("falls back to the configured default when sessionKey is missing", () => {
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      config: cfg,
    });
    expect(defaultAgentId).toBe("beta");
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default when sessionKey is non-agent", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "quietchat:slash:123",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default for global sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "global",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("keeps the agent id for provider-qualified agent sessions", () => {
    // Channel-qualified agent session keys still carry the owning agent in the
    // second segment.
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:quietchat:channel:c1",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("uses the agent id from agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:main:main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("uses explicit agentId when sessionKey is missing", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      agentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("prefers explicit agentId over non-agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "quietchat:slash:123",
      agentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("uses fallbackAgentId when the session key carries no agent", () => {
    // Channel routes keep the bound agent on the route even when the resolved
    // session key is unscoped; without this fallback the run defaults away from it.
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "quietchat:slash:123",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("prefers the session-key agent over fallbackAgentId", () => {
    // Command-turn cross-agent targeting encodes the target in the key; the bound
    // route agent must not override it.
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:quietchat:channel:c1",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("prefers explicit agentId over fallbackAgentId", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      agentId: "beta",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });
});
