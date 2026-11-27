import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_PROFILES, indexBuiltInAgentProfiles } from "./builtins.js";
import { resolveOpenClawAgentProfileExtension } from "./openclaw-extension.js";

function builtIn(id: string) {
  const profile = BUILT_IN_AGENT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) {
    throw new Error(`Missing built-in Agent Profile: ${id}`);
  }
  return profile;
}

describe("built-in Agent Profile resources", () => {
  it("indexes the built-ins and rejects a duplicate id before publishing", () => {
    const base = builtIn("openclaw/base");
    expect(indexBuiltInAgentProfiles(BUILT_IN_AGENT_PROFILES).get("openclaw/base")).toBe(base);
    expect(() => indexBuiltInAgentProfiles([base, base])).toThrow(
      "Duplicate built-in Agent Profile id: openclaw/base",
    );
  });

  it("keeps every resource structurally valid for agentprofiles.io/v1", () => {
    const ids = new Set<string>(BUILT_IN_AGENT_PROFILES.map((profile) => profile.id));
    for (const profile of BUILT_IN_AGENT_PROFILES) {
      const { resource } = profile;
      expect(resource.apiVersion).toBe("agentprofiles.io/v1");
      expect(resource.kind).toBe("AgentProfile");
      expect(`${resource.metadata.namespace}/${resource.metadata.name}`).toBe(profile.id);
      expect(resource.spec.common).toBeDefined();
      if (resource.extends !== undefined) {
        expect(ids.has(resource.extends)).toBe(true);
        expect(resource.extends).not.toBe(profile.id);
      }
    }
  });

  it("keeps OpenClaw settings out of portable common fields", () => {
    for (const profile of BUILT_IN_AGENT_PROFILES) {
      expect(profile.resource.spec.common).toEqual({});
    }
    const extension = resolveOpenClawAgentProfileExtension([builtIn("openclaw/compact")]);
    const workspaceContext = extension?.prompt?.workspaceContext;

    expect(extension?.toolProfile).toBe("compact");
    expect(workspaceContext?.totalMaxChars).toBeGreaterThan(0);
    for (const section of Object.values(workspaceContext?.sections ?? {})) {
      expect(section.maxChars).toBeLessThanOrEqual(workspaceContext?.totalMaxChars ?? 0);
    }
  });

  it("migrates Lean exactly: openclaw/small is the lean tool profile with no prompt limits", () => {
    expect(resolveOpenClawAgentProfileExtension([builtIn("openclaw/small")])).toEqual({
      toolProfile: "lean",
    });
  });
});
