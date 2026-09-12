// Resolves Claude CLI project directories honoring CLAUDE_CONFIG_DIR and the
// default ~/.claude/projects convention.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

const HOME = path.join(path.sep, "home", "demo-user");
const WORKSPACE_DIR = path.join(HOME, "work", "demo");
// sanitizeClaudeCliProjectKey replaces every non-alphanumeric char with "-".
const SANITIZED_KEY = WORKSPACE_DIR.replace(/[^a-zA-Z0-9]/g, "-");

describe("resolveClaudeCliProjectDirForWorkspace", () => {
  it("resolves under <homeDir>/.claude/projects by default", async () => {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: undefined, HOME }, () => {
      expect(
        resolveClaudeCliProjectDirForWorkspace({ workspaceDir: WORKSPACE_DIR, homeDir: HOME }),
      ).toBe(path.join(HOME, ".claude", "projects", SANITIZED_KEY));
    });
  });

  it("resolves under $CLAUDE_CONFIG_DIR/projects when configured", async () => {
    const configDir = path.join(HOME, ".ai-profiles", "claude-personal");
    await withEnvAsync({ CLAUDE_CONFIG_DIR: configDir, HOME }, () => {
      expect(
        resolveClaudeCliProjectDirForWorkspace({ workspaceDir: WORKSPACE_DIR, homeDir: HOME }),
      ).toBe(path.join(configDir, "projects", SANITIZED_KEY));
    });
  });

  it("falls back to <homeDir>/.claude/projects for a blank CLAUDE_CONFIG_DIR", async () => {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: "   ", HOME }, () => {
      expect(
        resolveClaudeCliProjectDirForWorkspace({ workspaceDir: WORKSPACE_DIR, homeDir: HOME }),
      ).toBe(path.join(HOME, ".claude", "projects", SANITIZED_KEY));
    });
  });

  it("resolves a relative CLAUDE_CONFIG_DIR against the process working directory", async () => {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: "claude-state", HOME }, () => {
      expect(
        resolveClaudeCliProjectDirForWorkspace({ workspaceDir: WORKSPACE_DIR, homeDir: HOME }),
      ).toBe(path.join(path.resolve("claude-state"), "projects", SANITIZED_KEY));
    });
  });
});
