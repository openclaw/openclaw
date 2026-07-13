import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredSubagentAnnounceTarget } from "./subagent-announce-target.js";

function cfgWith(agents: unknown): OpenClawConfig {
  return { agents } as OpenClawConfig;
}

describe("resolveConfiguredSubagentAnnounceTarget", () => {
  it("prefers the explicit per-call announceTarget over any config", () => {
    const cfg = cfgWith({
      defaults: { subagents: { announceTarget: "channel" } },
      list: [{ id: "main", subagents: { announceTarget: "channel" } }],
    });
    expect(
      resolveConfiguredSubagentAnnounceTarget({
        cfg,
        requesterAgentId: "main",
        announceTarget: "parent",
      }),
    ).toBe("parent");
  });

  it("uses the per-agent override even when the configured id casing/format differs from the normalized requester id", () => {
    // requesterAgentId reaches this resolver already normalized (lowercased).
    // A raw agent.id === id compare would miss "Work-Bot" and silently fall
    // back to defaults; the canonical resolver normalizes both sides.
    const cfg = cfgWith({
      defaults: { subagents: { announceTarget: "channel" } },
      list: [{ id: "Work-Bot", subagents: { announceTarget: "parent" } }],
    });
    expect(resolveConfiguredSubagentAnnounceTarget({ cfg, requesterAgentId: "work-bot" })).toBe(
      "parent",
    );
  });

  it("falls back to defaults when the requester agent has no per-agent announceTarget", () => {
    const cfg = cfgWith({
      defaults: { subagents: { announceTarget: "parent" } },
      list: [{ id: "main", subagents: {} }],
    });
    expect(resolveConfiguredSubagentAnnounceTarget({ cfg, requesterAgentId: "main" })).toBe(
      "parent",
    );
  });

  it("falls back to defaults when the requester agent id is not in the list", () => {
    const cfg = cfgWith({
      defaults: { subagents: { announceTarget: "parent" } },
      list: [{ id: "other", subagents: { announceTarget: "channel" } }],
    });
    expect(resolveConfiguredSubagentAnnounceTarget({ cfg, requesterAgentId: "missing" })).toBe(
      "parent",
    );
  });

  it('defaults to "channel" when nothing is configured', () => {
    expect(
      resolveConfiguredSubagentAnnounceTarget({
        cfg: cfgWith({}),
        requesterAgentId: "main",
      }),
    ).toBe("channel");
  });

  it("ignores invalid configured values and falls through to the default", () => {
    const cfg = cfgWith({
      defaults: { subagents: { announceTarget: "bogus" } },
      list: [{ id: "main", subagents: { announceTarget: "stream" } }],
    });
    expect(resolveConfiguredSubagentAnnounceTarget({ cfg, requesterAgentId: "main" })).toBe(
      "channel",
    );
  });
});
