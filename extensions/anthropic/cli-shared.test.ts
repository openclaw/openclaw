import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { normalizeClaudeBackendConfig, normalizeClaudePermissionArgs } from "./cli-shared.js";

describe("normalizeClaudePermissionArgs", () => {
  it("injects bypassPermissions when args omit permission flags", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("removes legacy skip-permissions and injects bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--dangerously-skip-permissions", "--verbose"]),
    ).toEqual(["-p", "--verbose", "--permission-mode", "bypassPermissions"]);
  });

  it("keeps explicit permission-mode overrides", () => {
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode", "acceptEdits"])).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode=acceptEdits"])).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
    ]);
  });
});

describe("normalizeClaudeBackendConfig", () => {
  it("normalizes both args and resumeArgs for custom overrides", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "{sessionId}",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("is wired through the anthropic cli backend normalize hook", () => {
    const backend = buildAnthropicCliBackend();
    const normalizeConfig = backend.normalizeConfig;

    expect(normalizeConfig).toBeTypeOf("function");

    const normalized = normalizeConfig?.({
      ...backend.config,
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized?.args).toContain("--permission-mode");
    expect(normalized?.args).toContain("bypassPermissions");
    expect(normalized?.resumeArgs).toContain("--permission-mode");
    expect(normalized?.resumeArgs).toContain("bypassPermissions");
  });
});
