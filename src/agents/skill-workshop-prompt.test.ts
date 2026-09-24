import { describe, expect, it } from "vitest";
import { buildSkillWorkshopPromptSection } from "./skill-workshop-prompt.js";

const section = () => buildSkillWorkshopPromptSection().join("\n");

describe("buildSkillWorkshopPromptSection", () => {
  it("allows user-requested edits to repository-owned skill source", () => {
    const prompt = section();
    expect(prompt).toContain("repository-owned");
    expect(prompt).toContain("ordinary repository checkout");
    expect(prompt).toContain("do not route them through Workshop");
    expect(prompt).toContain("normal repository file tools");
    expect(prompt).not.toContain("never write proposal/skill files directly");
  });

  it("does not infer Workshop ownership from a SKILL.md filename, skill-like directory, or installed-name collision", () => {
    const prompt = section();
    expect(prompt).toContain("`SKILL.md` filename");
    expect(prompt).toContain("skill-like directory");
    expect(prompt).toContain("name collision with an installed skill");
  });

  it("still blocks direct writes to Workshop proposal and skill files", () => {
    const prompt = section();
    expect(prompt).toContain(
      "never write Workshop proposal or Workshop-owned skill files directly",
    );
  });

  it("still gates publication, apply, and unsolicited repairs", () => {
    const prompt = section();
    expect(prompt).toContain("Draft-only reviews continue to stage proposals");
    expect(prompt).toContain("Publication-only create/update requires an explicit user request");
    expect(prompt).toContain("Apply/reject/quarantine only explicit user ask");
    expect(prompt).toContain("unsolicited improvements stay pending proposals");
  });
});
