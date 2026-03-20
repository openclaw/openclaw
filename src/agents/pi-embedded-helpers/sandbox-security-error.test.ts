import { describe, expect, it } from "vitest";
import { isSandboxSecurityError } from "./errors.js";

describe("isSandboxSecurityError", () => {
  it("detects bind mount outside allowed roots error", () => {
    expect(
      isSandboxSecurityError(
        'Sandbox security: bind mount "/home/user/.openclaw/sandbox-configs/config.json:/app/config.json:ro" ' +
          'source "/home/user/.openclaw/sandbox-configs/config.json" is outside allowed roots ' +
          "(/home/user/.openclaw/workspace-agent). Use a dangerous override only when you fully trust this runtime.",
      ),
    ).toBe(true);
  });

  it("detects non-absolute source path error", () => {
    expect(
      isSandboxSecurityError(
        'Sandbox security: bind mount "relative/path:/app/data:ro" uses a non-absolute source path.',
      ),
    ).toBe(true);
  });

  it("detects reserved container path error", () => {
    expect(
      isSandboxSecurityError(
        'Sandbox security: bind mount "/data:/proc:rw" targets reserved container path "/proc".',
      ),
    ).toBe(true);
  });

  it("detects blocked path error", () => {
    expect(
      isSandboxSecurityError(
        'Sandbox security: bind mount "/etc/shadow:/app/shadow:ro" reads blocked path "/etc/shadow".',
      ),
    ).toBe(true);
  });

  it("detects network mode blocked error", () => {
    expect(isSandboxSecurityError('Sandbox security: network mode "host" is blocked.')).toBe(true);
  });

  it("detects seccomp profile blocked error", () => {
    expect(
      isSandboxSecurityError('Sandbox security: seccomp profile "unconfined" is blocked.'),
    ).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isSandboxSecurityError("")).toBe(false);
  });

  it("returns false for unrelated error messages", () => {
    expect(isSandboxSecurityError("Connection timeout")).toBe(false);
    expect(isSandboxSecurityError("API rate limit reached")).toBe(false);
    expect(isSandboxSecurityError("context length exceeded")).toBe(false);
  });

  it("returns false for messages that mention sandbox without the security prefix", () => {
    expect(isSandboxSecurityError("sandbox container started")).toBe(false);
    expect(isSandboxSecurityError("running in sandbox mode")).toBe(false);
  });

  it("does not leak filesystem paths in the safe fallback message", () => {
    const rawError =
      'Sandbox security: bind mount "/home/ernest/.openclaw/sandbox-configs/config.json:/app/config.json:ro" ' +
      'source "/home/ernest/.openclaw/sandbox-configs/config.json" is outside allowed roots ' +
      "(/home/ernest/.openclaw/workspace-agent).";

    expect(isSandboxSecurityError(rawError)).toBe(true);

    // The safe message the channel receives should NOT contain any of these:
    const safeMessage = "⚠️ Agent failed to start. Check logs: openclaw logs --follow";
    expect(safeMessage).not.toContain("/home/ernest");
    expect(safeMessage).not.toContain(".openclaw");
    expect(safeMessage).not.toContain("sandbox-configs");
    expect(safeMessage).not.toContain("workspace-agent");
    expect(safeMessage).not.toContain("bind mount");
  });
});
