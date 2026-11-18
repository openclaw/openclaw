import { describe, expect, it } from "vitest";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import { SKILL_LEARNING_METHOD_PROMPT } from "./skill-authoring-standards.js";

describe("buildSkillExperienceReviewPrompt", () => {
  it("applies the shared learning method with the background one-change limit", () => {
    const prompt = buildSkillExperienceReviewPrompt({});

    expect(prompt).toContain(SKILL_LEARNING_METHOD_PROMPT);
    expect(prompt).toContain("Make at most one change.");
    expect(prompt).toContain("NO_REPLY");
  });
});
