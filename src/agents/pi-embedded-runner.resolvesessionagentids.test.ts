import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId, resolveSessionAgentIds } from "./agent-scope.js";

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
      sessionKey: "telegram:slash:123",
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
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:slack:channel:c1",
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
      sessionKey: "telegram:slash:123",
      agentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("falls back to first configured agent when no explicit default and no main entry", () => {
    const config = {
      agents: {
        list: [{ id: "triage" }, { id: "mail" }],
      },
    } as OpenClawConfig;

    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({ config });
    expect(defaultAgentId).toBe("triage");
    expect(sessionAgentId).toBe("triage");
  });

  it("still honors an explicit non-main default agent", () => {
    const config = {
      agents: {
        list: [{ id: "triage", default: true }, { id: "mail" }],
      },
    } as OpenClawConfig;

    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({ config });
    expect(defaultAgentId).toBe("triage");
    expect(sessionAgentId).toBe("triage");
  });

  it("prefers main as implicit default when present without default=true", () => {
    const config = {
      agents: {
        list: [{ id: "triage" }, { id: "main" }],
      },
    } as OpenClawConfig;

    expect(resolveDefaultAgentId(config)).toBe("main");
  });
});
