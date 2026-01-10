import { afterEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

describe("cli credentials", () => {
  afterEach(() => {
    execSyncMock.mockReset();
  });

  it("updates the Claude Code keychain item in place", async () => {
    const commands: string[] = [];

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      commands.push(cmd);

      if (cmd.includes("find-generic-password")) {
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: Date.now() + 60_000,
          },
        });
      }

      return "";
    });

    const { writeClaudeCliKeychainCredentials } = await import(
      "./cli-credentials.js"
    );

    const ok = writeClaudeCliKeychainCredentials({
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
    });

    expect(ok).toBe(true);
    expect(
      commands.some((cmd) => cmd.includes("delete-generic-password")),
    ).toBe(false);

    const updateCommand = commands.find((cmd) =>
      cmd.includes("add-generic-password"),
    );
    expect(updateCommand).toContain("-U");
  });
});
