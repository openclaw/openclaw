import { describe, expect, it } from "vitest";
import { buildClaudeTmuxArgs } from "./args.js";

describe("buildClaudeTmuxArgs", () => {
  it("removes print and bare flags while preserving MCP args", () => {
    const args = buildClaudeTmuxArgs({
      backend: { command: "claude", modelArg: "--model", sessionArg: "--session-id" },
      baseArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--bare",
        "--setting-sources",
        "user",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
      ],
      modelId: "sonnet",
      settingsFile: "/tmp/settings.json",
      managedSettingsJson: '{"allowManagedHooksOnly":true}',
      systemPromptFile: "/tmp/system.txt",
      sessionId: "session-id",
    });

    expect(args).not.toContain("-p");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--include-partial-messages");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
        "--settings",
        "/tmp/settings.json",
        "--managed-settings",
        '{"allowManagedHooksOnly":true}',
        "--setting-sources",
        "",
        "--append-system-prompt-file",
        "/tmp/system.txt",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
        "--session-id",
        "session-id",
      ]),
    );
  });
});
