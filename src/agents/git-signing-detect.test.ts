import { describe, expect, it } from "vitest";
import {
  buildGitSshSigningWarning,
  detectGitSshSigning,
  parseGitSigningCommand,
} from "./git-signing-detect.js";

describe("parseGitSigningCommand", () => {
  it("detects plain git commit", () => {
    expect(parseGitSigningCommand("git commit -m 'hello'")).toBe("commit");
  });

  it("detects git merge", () => {
    expect(parseGitSigningCommand("git merge main")).toBe("merge");
  });

  it("detects git tag", () => {
    expect(parseGitSigningCommand("git tag v1.0.0")).toBe("tag");
  });

  it("detects git rebase", () => {
    expect(parseGitSigningCommand("git rebase main")).toBe("rebase");
  });

  it("detects git cherry-pick", () => {
    expect(parseGitSigningCommand("git cherry-pick abc123")).toBe("cherry-pick");
  });

  it("detects git push", () => {
    expect(parseGitSigningCommand("git push origin main")).toBe("push");
  });

  it("detects git commit with -C flag", () => {
    expect(parseGitSigningCommand("git -C /some/path commit -m 'test'")).toBe("commit");
  });

  it("detects git commit with -c config flag", () => {
    expect(parseGitSigningCommand("git -c user.name=test commit -m 'test'")).toBe("commit");
  });

  it("detects git commit after cd command", () => {
    expect(parseGitSigningCommand("cd /project && git commit -m 'test'")).toBe("commit");
  });

  it("detects git commit with env prefix", () => {
    expect(parseGitSigningCommand("GIT_AUTHOR_NAME=test git commit -m 'test'")).toBe("commit");
  });

  it("returns null for non-git commands", () => {
    expect(parseGitSigningCommand("ls -la")).toBeNull();
  });

  it("returns null for git commands that dont trigger signing", () => {
    expect(parseGitSigningCommand("git status")).toBeNull();
    expect(parseGitSigningCommand("git log")).toBeNull();
    expect(parseGitSigningCommand("git diff")).toBeNull();
    expect(parseGitSigningCommand("git fetch origin")).toBeNull();
    expect(parseGitSigningCommand("git pull")).toBeNull();
    expect(parseGitSigningCommand("git clone repo")).toBeNull();
    expect(parseGitSigningCommand("git add .")).toBeNull();
  });

  it("returns null when --no-gpg-sign is used", () => {
    expect(parseGitSigningCommand("git commit --no-gpg-sign -m 'test'")).toBeNull();
  });

  it("returns null when commit.gpgsign=false is used", () => {
    expect(parseGitSigningCommand("git -c commit.gpgsign=false commit -m 'test'")).toBeNull();
  });

  it("returns null for empty command", () => {
    expect(parseGitSigningCommand("")).toBeNull();
  });

  it("handles piped git commands", () => {
    expect(parseGitSigningCommand("echo test | git commit -m 'test'")).toBe("commit");
  });

  it("handles semicolon-separated git commands", () => {
    expect(parseGitSigningCommand("git add . ; git commit -m 'test'")).toBe("commit");
  });
});

describe("detectGitSshSigning", () => {
  it("returns result without throwing for any directory", async () => {
    const result = await detectGitSshSigning(process.cwd());
    expect(result).toHaveProperty("sshSigning");
    expect(result).toHaveProperty("gpgSignEnabled");
    expect(result).toHaveProperty("gpgFormat");
    expect(typeof result.sshSigning).toBe("boolean");
    expect(typeof result.gpgSignEnabled).toBe("boolean");
  });

  it("does not throw for non-existent directory", async () => {
    const result = await detectGitSshSigning("/nonexistent/path/abc123");
    expect(result.sshSigning).toBe(false);
    expect(result.gpgSignEnabled).toBe(false);
  });
});

describe("buildGitSshSigningWarning", () => {
  it("includes the subcommand in the warning", () => {
    const warning = buildGitSshSigningWarning("commit");
    expect(warning).toContain("git commit");
    expect(warning).toContain("SSH-based commit signing");
    expect(warning).toContain("pty=true");
    expect(warning).toContain("--no-gpg-sign");
  });

  it("includes workaround with the correct subcommand", () => {
    const warning = buildGitSshSigningWarning("merge");
    expect(warning).toContain("git merge");
    expect(warning).toContain("git -c commit.gpgsign=false merge");
  });
});
