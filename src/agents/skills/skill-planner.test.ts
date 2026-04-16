import { describe, expect, it } from "vitest";
import { resolveSkillPlanTemplate } from "../pi-embedded-runner/skills-runtime.js";
import { buildPlanTemplatePayload, hasSkillPlanTemplate } from "./skill-planner.js";
import type { SkillPlanTemplateStep } from "./types.js";

describe("buildPlanTemplatePayload", () => {
  it("returns null for empty template", () => {
    expect(buildPlanTemplatePayload("deploy", [])).toBeNull();
  });

  it("returns null for undefined template", () => {
    expect(buildPlanTemplatePayload("deploy", undefined)).toBeNull();
    expect(buildPlanTemplatePayload("deploy")).toBeNull();
  });

  it("builds pending steps from template", () => {
    const template: SkillPlanTemplateStep[] = [
      { step: "Run tests", activeForm: "Running tests" },
      { step: "Build", activeForm: "Building" },
      { step: "Deploy" },
    ];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result).not.toBeNull();
    expect(result!.plan).toHaveLength(3);
    expect(result!.plan.every((s) => s.status === "pending")).toBe(true);
  });

  it("preserves activeForm when present", () => {
    const template: SkillPlanTemplateStep[] = [{ step: "Run tests", activeForm: "Running tests" }];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result!.plan[0].activeForm).toBe("Running tests");
  });

  it("omits activeForm when absent", () => {
    const template: SkillPlanTemplateStep[] = [{ step: "Deploy" }];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result!.plan[0]).not.toHaveProperty("activeForm");
  });

  it("includes skill name in explanation", () => {
    const result = buildPlanTemplatePayload("release-cut", [{ step: "Tag" }]);
    expect(result!.explanation).toContain("release-cut");
  });
});

describe("hasSkillPlanTemplate", () => {
  it("returns false for undefined metadata", () => {
    expect(hasSkillPlanTemplate(undefined)).toBe(false);
  });

  it("returns false for empty planTemplate", () => {
    expect(hasSkillPlanTemplate({ planTemplate: [] })).toBe(false);
  });

  it("returns true for non-empty planTemplate", () => {
    expect(hasSkillPlanTemplate({ planTemplate: [{ step: "x" }] })).toBe(true);
  });
});

describe("resolveSkillPlanTemplate", () => {
  it("returns null when no entries have a plan template", () => {
    const entries = [
      { skill: { name: "deploy" }, metadata: {} },
      { skill: { name: "lint" }, metadata: { planTemplate: [] } },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];
    expect(resolveSkillPlanTemplate(entries)).toBeNull();
  });

  it("returns payload for the first entry with a plan template", () => {
    const entries = [
      { skill: { name: "deploy" }, metadata: {} },
      {
        skill: { name: "release" },
        metadata: { planTemplate: [{ step: "Tag release" }] },
      },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];
    const result = resolveSkillPlanTemplate(entries);
    expect(result).not.toBeNull();
    expect(result!.plan[0].step).toBe("Tag release");
    expect(result!.explanation).toContain("release");
  });

  it("returns null for empty entries array", () => {
    expect(resolveSkillPlanTemplate([])).toBeNull();
  });
});
