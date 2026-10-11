import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("resolveClaudeCliProjectDirForWorkspace", () => {
  let homeDir: string;
  let workspaceDir: string;
  let projectKey: string;

  beforeEach(() => {
    const root = fs.realpathSync.native(tempDirs.make("oc-claude-project-dir-"));
    homeDir = path.join(root, "home");
    workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir);
    projectKey = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
  });

  it.each([
    { name: "unset", value: undefined, relativeRoot: undefined },
    { name: "empty", value: "", relativeRoot: "" },
    { name: "spaces only", value: "  ", relativeRoot: "  " },
    { name: "relative", value: "claude config", relativeRoot: "claude config" },
    { name: "trailing space", value: "claude config ", relativeRoot: "claude config " },
    { name: "decomposed Unicode", value: "cafe\u0301", relativeRoot: "caf\u00e9" },
  ])("matches Claude Code's $name config root", ({ value, relativeRoot }) => {
    const expectedRoot =
      relativeRoot === undefined
        ? path.join(homeDir, ".claude")
        : path.join(workspaceDir, relativeRoot);
    expect(
      resolveClaudeCliProjectDirForWorkspace({
        workspaceDir,
        env: { HOME: homeDir, CLAUDE_CONFIG_DIR: value },
      }),
    ).toBe(path.join(expectedRoot, "projects", projectKey));
  });

  it("uses an absolute config root and isolates an explicitly injected environment", () => {
    const alternate = path.join(homeDir, "selected Claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
    expect(resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir })).toBe(
      path.join(alternate, "projects", projectKey),
    );
    expect(resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir, env: {} })).toBe(
      path.join(homeDir, ".claude", "projects", projectKey),
    );
  });

  it("resolves a relative config root and project key through a symlinked workspace", () => {
    const link = path.join(path.dirname(workspaceDir), "workspace-link");
    fs.symlinkSync(workspaceDir, link, process.platform === "win32" ? "junction" : "dir");
    expect(
      resolveClaudeCliProjectDirForWorkspace({
        workspaceDir: link,
        homeDir,
        env: { CLAUDE_CONFIG_DIR: "claude" },
      }),
    ).toBe(path.join(workspaceDir, "claude", "projects", projectKey));
  });
});
