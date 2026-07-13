// Agent-bundle prompt tests cover mandatory coding invariants in default and custom prompts.
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

function expectGitWorkIsolation(prompt: string): void {
  expect(prompt).toContain("## Git Work Isolation");
  expect(prompt).toContain("Coding tasks that modify a Git-backed project");
  expect(prompt).toContain("Read-only tasks and non-Git scratch work");
  expect(prompt).toContain("`upstream` when it matches that target");
  expect(prompt).toContain("git fetch --prune <canonical>");
  expect(prompt).toContain("isolated worktree");
  expect(prompt).toContain("initial `HEAD` equals the fetched base SHA");
  expect(prompt).toContain("Existing PR/shared branch");
  expect(prompt).toContain("fetch canonical and the contributor branch");
  expect(prompt).toContain("Preserve contributor history");
  expect(prompt).toContain("git merge-base --is-ancestor");
}

describe("buildSystemPrompt", () => {
  it("includes Git work isolation in the default agent-bundle prompt", () => {
    expectGitWorkIsolation(buildSystemPrompt({ cwd: "/tmp/project" }));
  });

  it("retains Git work isolation when a custom prompt is supplied", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/project",
      customPrompt: "Custom coding instructions.",
    });

    expect(prompt).toContain("Custom coding instructions.");
    expectGitWorkIsolation(prompt);
  });
});
