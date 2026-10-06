import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveClaudeCliConfigDir,
  resolveClaudeCliProjectDirForWorkspace,
} from "./claude-cli-project-dir.js";

const workspaceDir = path.join(os.tmpdir(), "openclaw-project-dir-test", "workspace");
const projectKey = path
  .resolve(workspaceDir)
  .normalize("NFC")
  .replace(/[^a-zA-Z0-9]/g, "-");

describe("resolveClaudeCliProjectDirForWorkspace", () => {
  it("uses ~/.claude/projects when no Claude config dir is configured", () => {
    const env = { HOME: "/srv/home" };
    expect(resolveClaudeCliProjectDirForWorkspace({ workspaceDir, env })).toBe(
      path.join("/srv/home", ".claude", "projects", projectKey),
    );
  });

  it("follows CLAUDE_CONFIG_DIR because the spawned Claude CLI writes transcripts there", () => {
    // Regression: the Gateway forwards CLAUDE_CONFIG_DIR to `claude`, which then writes
    // `$CLAUDE_CONFIG_DIR/projects/<key>/<sessionId>.jsonl`. Probing HOME instead read
    // every session as transcript-missing (live-session failover + binding resets).
    const env = { HOME: "/srv/home", CLAUDE_CONFIG_DIR: "/srv/gateway-claude" };
    expect(resolveClaudeCliProjectDirForWorkspace({ workspaceDir, env })).toBe(
      path.join("/srv/gateway-claude", "projects", projectKey),
    );
  });

  it("ignores a blank CLAUDE_CONFIG_DIR", () => {
    const env = { HOME: "/srv/home", CLAUDE_CONFIG_DIR: "   " };
    expect(resolveClaudeCliProjectDirForWorkspace({ workspaceDir, env })).toBe(
      path.join("/srv/home", ".claude", "projects", projectKey),
    );
  });

  it("keeps an explicit homeDir HOME-relative even when CLAUDE_CONFIG_DIR is set", () => {
    // An injected home describes a fixture layout (doctor, tests); it is not a
    // configured override and must not be redirected by the process environment.
    const env = { HOME: "/srv/home", CLAUDE_CONFIG_DIR: "/srv/gateway-claude" };
    expect(
      resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: "/srv/fixture", env }),
    ).toBe(path.join("/srv/fixture", ".claude", "projects", projectKey));
  });
});

describe("resolveClaudeCliConfigDir", () => {
  it("resolves a relative CLAUDE_CONFIG_DIR against the process cwd like Claude Code does", () => {
    expect(
      resolveClaudeCliConfigDir({ env: { HOME: "/srv/home", CLAUDE_CONFIG_DIR: "rel" } }),
    ).toBe(path.resolve("rel"));
  });

  it("falls back to os.homedir() when HOME is unset", () => {
    expect(resolveClaudeCliConfigDir({ env: {} })).toBe(path.join(os.homedir(), ".claude"));
  });
});
