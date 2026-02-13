import { describe, expect, it } from "vitest";
import { resolveCliBackendConfig } from "./cli-backends.js";

describe("resolveCliBackendConfig", () => {
  it("uses codex defaults that are compatible with `codex exec resume`", () => {
    const resolved = resolveCliBackendConfig("codex-cli");
    expect(resolved).not.toBeNull();
    const backend = resolved?.config;
    expect(backend?.args).toEqual([
      "-c",
      "features.shell_snapshot=false",
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ]);
    expect(backend?.resumeArgs).toEqual([
      "-c",
      "features.shell_snapshot=false",
      "exec",
      "resume",
      "{sessionId}",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(backend?.resumeOutput).toBe("jsonl");
  });
});
