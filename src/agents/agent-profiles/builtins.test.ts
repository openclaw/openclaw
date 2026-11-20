import { validateAgentProfile } from "agentprofiles";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_AGENT_PROFILES } from "./builtins.js";
import { resolveOpenClawAgentProfileExtension } from "./openclaw-extension.js";

function builtIn(id: string) {
  const profile = BUILT_IN_AGENT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) {
    throw new Error(`Missing built-in Agent Profile: ${id}`);
  }
  return profile;
}

describe("built-in Agent Profile resources", () => {
  it("passes every resource through the released portable validator", () => {
    for (const profile of BUILT_IN_AGENT_PROFILES) {
      expect(validateAgentProfile(profile.resource)).toBe(profile.resource);
    }
  });

  it("loads the built-ins without loading the portable validator", async () => {
    vi.resetModules();
    vi.doMock("agentprofiles", () => {
      throw new Error("agentprofiles must not load at import time");
    });
    try {
      const fresh = await import("./builtins.js");
      expect(fresh.BUILT_IN_AGENT_PROFILES.map((profile) => profile.id)).toEqual([
        "openclaw/base",
        "openclaw/small",
      ]);
    } finally {
      vi.doUnmock("agentprofiles");
      vi.resetModules();
    }
  });

  it("keeps OpenClaw settings out of portable common fields", () => {
    const small = builtIn("openclaw/small");

    expect(small.resource.spec.common).toEqual({});
    expect(resolveOpenClawAgentProfileExtension([small])).toEqual({
      toolProfile: "compact",
      prompt: {
        workspaceContext: {
          totalMaxChars: 11_500,
          sections: {
            agents: { maxChars: 7_500 },
            soul: { maxChars: 2_000 },
            identity: { maxChars: 1_024 },
            user: { maxChars: 2_000 },
          },
        },
      },
    });
  });
});
