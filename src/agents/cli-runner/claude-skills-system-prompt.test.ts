import { describe, expect, it } from "vitest";
import { stripOpenClawSkillsPromptSection } from "./claude-skills-system-prompt.js";

describe("stripOpenClawSkillsPromptSection", () => {
  it("removes only the OpenClaw skills section from a CLI system prompt", () => {
    const prompt = [
      "You are a personal assistant running inside OpenClaw.",
      "",
      "## Tooling",
      "No OpenClaw tool list is injected.",
      "",
      "## Skills",
      "Scan <available_skills> before replying.",
      "<available_skills>",
      "<skill><name>weather</name></skill>",
      "</available_skills>",
      "",
      "## Memory",
      "Remember useful facts.",
    ].join("\n");

    expect(stripOpenClawSkillsPromptSection(prompt)).toBe(
      [
        "You are a personal assistant running inside OpenClaw.",
        "",
        "## Tooling",
        "No OpenClaw tool list is injected.",
        "",
        "## Memory",
        "Remember useful facts.",
      ].join("\n"),
    );
  });

  it("leaves prompts without an OpenClaw skills section unchanged", () => {
    const prompt = "## Tooling\nNo tools.\n\n## Memory\nRemember facts.";
    expect(stripOpenClawSkillsPromptSection(prompt)).toBe(prompt);
  });
});
