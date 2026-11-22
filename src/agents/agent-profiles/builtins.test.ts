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
    for (const profile of BUILT_IN_AGENT_PROFILES) {
      expect(profile.resource.spec.common).toEqual({});
    }
    const extension = resolveOpenClawAgentProfileExtension([builtIn("openclaw/small")]);
    const workspaceContext = extension?.prompt?.workspaceContext;

    expect(extension?.toolProfile).toBe("compact");
    expect(extension?.contextSerialization).toBe("compact");
    expect(workspaceContext?.totalMaxChars).toBeGreaterThan(0);
    for (const section of Object.values(workspaceContext?.sections ?? {})) {
      expect(section.maxChars).toBeLessThanOrEqual(workspaceContext?.totalMaxChars ?? 0);
    }
  });
});
