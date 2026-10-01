import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import { AgentSelectionRequiredError } from "./agent-scope-config.js";
import { resolveSessionAgentIdStrict as resolve, resolveSessionAgentIds } from "./agent-scope.js";

const config: OpenClawConfig = { agents: { entries: { main: {}, beta: {} } } };
const fixedStore = (agentId: string): OpenClawConfig => ({
  session: { store: "/tmp/shared.sqlite" },
  agents: {
    ownership: "explicit",
    defaults: { sessionStore: { agentId } },
    entries: { main: {}, beta: {} },
  },
});

describe("session agent ownership", () => {
  it("does not read unrelated roster entries for a prepared owner", () => {
    let unrelatedReads = 0;
    const prepared: OpenClawConfig = {
      agents: {
        entries: {
          main: {},
          get unrelated() {
            unrelatedReads += 1;
            return {};
          },
        },
      },
    };
    expect(resolve({ config: prepared, agentId: "main" })).toBe("main");
    expect(unrelatedReads).toBe(0);
  });

  it("rejects an invalid explicit selector before resolving the session owner", () => {
    expect(() => resolve({ config, agentId: "!!!", sessionKey: "agent:main:main" })).toThrow(
      "Invalid explicit agent id",
    );
  });

  it("rejects malformed agent keys before selecting a fallback", () => {
    expect(() => resolve({ config, sessionKey: "agent::broken", fallbackAgentId: "main" })).toThrow(
      "Malformed agent session key",
    );
  });

  it("requires an owner in an ambiguous roster", () => {
    expect(() => resolve({ config })).toThrow(AgentSelectionRequiredError);
  });

  it.each([
    { config: {}, expected: "main" },
    { config: { agents: { entries: { beta: {} } } }, expected: "beta" },
    {
      config: { agents: { list: [{ id: "main" }, { id: "beta", default: true }] } },
      expected: "beta",
    },
  ])("preserves ownerless fallback for %j", ({ config: fallbackConfig, expected }) => {
    expect(resolve({ config: fallbackConfig })).toBe(expected);
  });

  it("uses the retained migration owner only while configured", () => {
    const migrated: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
    };
    setRetainedLegacyDefaultAgentId(migrated, "beta");
    expect(resolve({ config: migrated })).toBe("beta");
    setRetainedLegacyDefaultAgentId(migrated, "retired");
    expect(() => resolve({ config: migrated })).toThrow(AgentSelectionRequiredError);
  });

  it("uses the configured fixed-store owner for global sessions", () => {
    expect(resolve({ config: fixedStore("beta"), sessionKey: "global" })).toBe("beta");
  });

  it("rejects a conflicting fixed-store owner", () => {
    expect(() =>
      resolve({ config: fixedStore("beta"), sessionKey: "global", agentId: "main" }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("rejects a retired unscoped fixed-store owner even with an explicit selector", () => {
    expect(() =>
      resolve({ config: fixedStore("retired"), sessionKey: "global", agentId: "beta" }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("keeps agent-scoped sessions available when the fixed-store owner retires", () => {
    expect(
      resolve({ config: fixedStore("retired"), sessionKey: "agent:beta:main", agentId: "beta" }),
    ).toBe("beta");
  });

  it("rejects a selector conflicting with the agent-scoped key", () => {
    expect(() => resolve({ config, sessionKey: "agent:beta:main", agentId: "main" })).toThrow(
      AgentSelectionRequiredError,
    );
  });

  it.each([
    { owner: { sessionKey: "feishu:direct:ou_user1", fallbackAgentId: "main" }, expected: "main" },
    {
      owner: { sessionKey: "agent:beta:feishu:direct:ou_user1", fallbackAgentId: "main" },
      expected: "beta",
    },
    {
      owner: { sessionKey: "feishu:direct:ou_user1", agentId: "beta", fallbackAgentId: "main" },
      expected: "beta",
    },
  ])("selects the prepared owner by precedence: $owner", ({ owner, expected }) => {
    expect(resolve({ config, ...owner })).toBe(expected);
  });

  it.each(["raw", "retained"])("preserves a different %s default for paired callers", (source) => {
    const paired: OpenClawConfig = {
      agents: { entries: { main: { default: source === "raw" }, beta: {} } },
    };
    if (source === "retained") {
      setRetainedLegacyDefaultAgentId(paired, "main");
    }
    expect(resolveSessionAgentIds({ config: paired, agentId: "beta" })).toEqual({
      defaultAgentId: "main",
      sessionAgentId: "beta",
    });
  });
});
