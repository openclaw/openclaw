// Agent-bundle prompt tests cover mandatory coding invariants in default and custom prompts.
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

function expectGitWorkIsolation(prompt: string): void {
  expect(prompt).toContain("## Git Work Isolation");
  expect(prompt).toContain("intended PR target repository");
  expect(prompt).toContain("`upstream` preferred when it matches");
  expect(prompt).toContain("git fetch --prune <canonical>");
  expect(prompt).toContain("isolated worktree");
  expect(prompt).toContain("initial `HEAD` must equal that fetched base");
  expect(prompt).toContain("Existing PR/shared branch");
  expect(prompt).toContain("fetch canonical and the contributor branch");
  expect(prompt).toContain("rebase/merge/reset/force-push");
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
