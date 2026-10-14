import { describe, expect, it } from "vitest";
import { commandInvokesGitHubCli } from "./github-invalid-selection.js";

describe("commandInvokesGitHubCli", () => {
  it("does not treat quoted GitHub text as a CLI invocation", () => {
    expect(commandInvokesGitHubCli('echo "gh api user"')).toBe(false);
  });

  it("detects GitHub CLI paths, pipelines, and assignments", () => {
    expect(commandInvokesGitHubCli("/usr/bin/gh api user")).toBe(true);
    expect(commandInvokesGitHubCli("echo hello && gh api user")).toBe(true);
    expect(commandInvokesGitHubCli("GH_TOKEN=example gh api user")).toBe(true);
  });

  it("treats unparseable shell as credential-bound", () => {
    expect(commandInvokesGitHubCli('echo "unterminated')).toBe(true);
  });
});
