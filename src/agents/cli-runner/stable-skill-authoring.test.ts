import { describe, expect, it } from "vitest";
import { expireSkillLibraryAuthoring } from "../../auto-reply/reply/transcript-followup-run.js";
import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { createConfiguredSkillWorkshopTool } from "../tools/skill-workshop-tool-factory.js";
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

const tool = (libraryAuthoring?: SkillLibraryAuthoringCapability, saved = presentation.workshop) =>
  createConfiguredSkillWorkshopTool({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:continuity",
    run: { libraryAuthoring, presentation: saved },
  });

describe("Workshop presentation without retained authority", () => {
  it("keeps schema and description after authority expires, and refuses personal and recovery workspace writes", async () => {
    const human = tool(authoring);
    const recovered = tool(
      expireSkillLibraryAuthoring(authoring, "Recovery requires a fresh request."),
    );
    const cold = tool();
    for (const resumed of [recovered, cold]) {
      expect(resumed.parameters).toEqual(human.parameters);
      expect(resumed.description).toBe(human.description);
      await expect(
        resumed.execute("personal", { action: "list", target: "personal" }),
      ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    }
    await expect(recovered.execute("workspace", { action: "list" })).rejects.toMatchObject({
      code: "AUTHORITY_EXPIRED",
    });
  });

  it("projects node Workshop to personal while retaining the independent Automations variant", async () => {
    expect(resolveCliToolDiscovery(undefined, true)).toBeUndefined();
    const node = resolveCliToolDiscovery(presentation, true);
    expect(node).toEqual({
      workshop: { defaultTarget: "personal", multipleProfiles: true },
      automations: "management",
    });
    await expect(
      tool(undefined, node!.workshop).execute("workspace", { action: "list" }),
    ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    expect(presentation.workshop?.defaultTarget).toBe("workspace");
  });
});
