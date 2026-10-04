// Exercise Windows path semantics on every host with Node's real win32 implementation.
import { describe, expect, it, vi } from "vitest";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, default: actual.win32 };
});

import {
  resolveClaudeCliProjectDirForWorkspace,
  resolveClaudeCliProjectsRoot,
  resolveClaudeCliProjectsRootAsync,
} from "./claude-cli-project-dir.js";

const cwd = "Z:\\openclaw-config-dir-test\\workspace";

describe("Windows Claude transcript roots", () => {
  it.each([
    ["\\profile", "Z:\\profile\\projects"],
    ["D:\\profile", "D:\\profile\\projects"],
    ["\\\\server\\share\\profile", "\\\\server\\share\\profile\\projects"],
  ])("resolves %s consistently for runtime and history", async (configDir, expected) => {
    const params = { cwd, env: { CLAUDE_CONFIG_DIR: configDir } };
    expect(resolveClaudeCliProjectsRoot(params)).toBe(expected);
    expect(await resolveClaudeCliProjectsRootAsync(params)).toBe(expected);
    expect(resolveClaudeCliProjectDirForWorkspace({ ...params, workspaceDir: cwd })).toBe(
      `${expected}\\Z--openclaw-config-dir-test-workspace`,
    );
  });

  it("requires the child drive for a root-relative profile", async () => {
    const params = { env: { CLAUDE_CONFIG_DIR: "\\profile" } };
    expect(resolveClaudeCliProjectsRoot(params)).toBeUndefined();
    expect(await resolveClaudeCliProjectsRootAsync(params)).toBeUndefined();
  });
});
