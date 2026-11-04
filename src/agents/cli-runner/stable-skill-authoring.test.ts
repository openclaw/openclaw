import { describe, expect, it } from "vitest";
import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { resolvePresentedSkillLibraryAuthoring } from "../../skills/library/presented-authoring.js";
import { createSkillLibraryTool } from "../tools/skill-library-tool.js";
import { resolveCliToolDiscovery } from "./stable-skill-authoring.js";

const presentation: SessionToolDiscoveryPresentation = {
  workshop: { defaultTarget: "workspace", multipleProfiles: true },
  automations: "management",
};

// The executor fixture fails if passive presentation ever becomes a live grant.
const authoring: SkillLibraryAuthoringCapability = {
  target: "personal",
  defaultTarget: "workspace",
  multipleProfiles: true,
  bind() {},
  invoke: async () => {
    throw new Error("unexpected live invocation");
  },
};

describe("library presentation without retained authority", () => {
  it("keeps the library definition and Workshop default after authority expires", async () => {
    expect(resolvePresentedSkillLibraryAuthoring(authoring, presentation.workshop)).toBe(authoring);
    expect(resolvePresentedSkillLibraryAuthoring(undefined, undefined)).toBeUndefined();
    const presented = resolvePresentedSkillLibraryAuthoring(undefined, presentation.workshop)!;
    expect(presented).toMatchObject({ defaultTarget: "workspace", multipleProfiles: true });
    // No workspace gate: Workshop keeps the ordinary no-grant rule.
    expect(presented.assertWorkspaceCurrent).toBeUndefined();
    const human = createSkillLibraryTool(authoring);
    const resumed = createSkillLibraryTool(presented);
    expect(resumed.parameters).toEqual(human.parameters);
    expect(resumed.description).toBe(human.description);
    await expect(resumed.execute("personal", { action: "list" })).rejects.toMatchObject({
      code: "AUTHORITY_EXPIRED",
    });
  });

  it("projects node Workshop to personal while retaining the independent Automations variant", () => {
    expect(resolveCliToolDiscovery(undefined, true)).toBeUndefined();
    expect(resolveCliToolDiscovery(presentation, true)).toEqual({
      workshop: { defaultTarget: "personal", multipleProfiles: true },
      automations: "management",
    });
    expect(presentation.workshop?.defaultTarget).toBe("workspace");
  });
});
