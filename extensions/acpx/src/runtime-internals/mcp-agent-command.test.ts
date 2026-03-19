import { describe, expect, it, vi } from "vitest";

const { spawnAndCollectMock } = vi.hoisted(() => ({
  spawnAndCollectMock: vi.fn(),
}));

vi.mock("./process.js", () => ({
  spawnAndCollect: spawnAndCollectMock,
}));

import { __testing, resolveAcpxAgentCommand } from "./mcp-agent-command.js";
import { splitCommandLine } from "./mcp-proxy.mjs";

describe("resolveAcpxAgentCommand", () => {
  it("threads stripProviderAuthEnvVars through the config show probe", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        agents: {
          codex: {
            command: "custom-codex",
          },
        },
      }),
      stderr: "",
      code: 0,
      error: null,
    });

    const command = await resolveAcpxAgentCommand({
      acpxCommand: "/plugin/node_modules/.bin/acpx",
      cwd: "/plugin",
      agent: "codex",
      stripProviderAuthEnvVars: true,
    });

    expect(command).toBe("custom-codex");
    expect(spawnAndCollectMock).toHaveBeenCalledWith(
      {
        command: "/plugin/node_modules/.bin/acpx",
        args: ["--cwd", "/plugin", "config", "show"],
        cwd: "/plugin",
        stripProviderAuthEnvVars: true,
      },
      undefined,
    );
  });
});

describe("buildMcpProxyAgentCommand", () => {
  it("escapes Windows-style proxy paths without double-escaping backslashes", () => {
    const quoted = __testing.quoteCommandPart(
      "C:\\repo\\extensions\\acpx\\src\\runtime-internals\\mcp-proxy.mjs",
    );

    expect(quoted).toBe(
      '"C:\\\\repo\\\\extensions\\\\acpx\\\\src\\\\runtime-internals\\\\mcp-proxy.mjs"',
    );
    expect(quoted).not.toContain("\\\\\\");
  });

  it("parses quoted Windows executable paths without dropping backslashes", () => {
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --stdio --flag "two words"',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--stdio", "--flag", "two words"],
    });
  });

  it("parses unquoted Windows executable paths with spaces as the command", () => {
    const parsed = splitCommandLine(
      "C:\\Program Files\\Claude\\claude.exe --stdio --dangerously-skip-permissions",
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--stdio", "--dangerously-skip-permissions"],
    });
  });
});
