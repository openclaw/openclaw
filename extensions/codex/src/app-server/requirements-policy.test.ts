import { describe, expect, it } from "vitest";
import {
  classifyCodexRequirementsPolicyError,
  defaultCodexRequirementsPolicyPath,
  parseCodexRequirementsPolicy,
  readCodexRequirementsPolicy,
} from "./requirements-policy.js";

describe("Codex requirements policy", () => {
  it("parses allowed sandbox modes from requirements.toml", () => {
    expect(
      parseCodexRequirementsPolicy(
        'allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess", "ReadOnly"]',
        { sourcePath: "/test/requirements.toml" },
      ),
    ).toEqual({
      sourcePath: "/test/requirements.toml",
      allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
    });
  });

  it("returns source metadata when no sandbox policy key exists", () => {
    expect(parseCodexRequirementsPolicy("approval_policy = 'on-request'")).toEqual({
      sourcePath: "/etc/codex/requirements.toml",
    });
  });

  it("ignores sandbox modes in TOML comments", () => {
    expect(
      parseCodexRequirementsPolicy(
        [
          'allowed_sandbox_modes = ["WorkspaceWrite", # "DangerFullAccess"',
          '  "ReadOnly"] # "DangerFullAccess"',
        ].join("\n"),
        { sourcePath: "/test/requirements.toml" },
      ),
    ).toEqual({
      sourcePath: "/test/requirements.toml",
      allowedSandboxModes: ["workspace-write", "read-only"],
    });
  });

  it("uses the managed Codex requirements path on Windows", () => {
    expect(defaultCodexRequirementsPolicyPath({ ProgramData: "D:\\ProgramData" }, "win32")).toBe(
      "D:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
    );
    expect(defaultCodexRequirementsPolicyPath({}, "win32")).toBe(
      "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
    );
  });

  it("treats missing requirements files as no policy", () => {
    expect(
      readCodexRequirementsPolicy({
        sourcePath: "/missing/requirements.toml",
        readFile: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
    ).toBeUndefined();
  });

  it("classifies app-server sandbox policy rejection errors", () => {
    const error = new Error(
      "invalid turn context override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by /etc/codex/requirements.toml)",
    );

    expect(classifyCodexRequirementsPolicyError(error)?.message).toContain(
      "requested sandbox danger-full-access is blocked by /etc/codex/requirements.toml",
    );
  });
});
