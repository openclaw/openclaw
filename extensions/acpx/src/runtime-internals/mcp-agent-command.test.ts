import { describe, expect, it, vi } from "vitest";

// Mock spawnAndCollect so loadAgentOverrides always returns empty overrides,
// letting resolveAcpxAgentCommand fall through to the built-in command table.
vi.mock("./process.js", () => ({
  spawnAndCollect: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "", error: undefined }),
}));

import { resolveAcpxAgentCommand } from "./mcp-agent-command.js";

const defaultParams = { acpxCommand: "acpx", cwd: "/tmp" };

describe("built-in agent commands", () => {
  it("resolves each built-in agent to its expected command", async () => {
    const expected: Record<string, string> = {
      codex: "npx @zed-industries/codex-acp",
      claude: "npx -y @zed-industries/claude-agent-acp",
      gemini: "gemini --experimental-acp",
      opencode: "npx -y opencode-ai acp",
      pi: "npx pi-acp",
    };

    for (const [agent, command] of Object.entries(expected)) {
      expect(await resolveAcpxAgentCommand({ ...defaultParams, agent })).toBe(command);
    }
  });

  it("gemini command includes --experimental-acp flag for ACP mode", async () => {
    const cmd = await resolveAcpxAgentCommand({ ...defaultParams, agent: "gemini" });
    expect(cmd).toContain("--experimental-acp");
  });

  it("returns raw agent string for unknown agents", async () => {
    const cmd = await resolveAcpxAgentCommand({ ...defaultParams, agent: "unknown-agent" });
    expect(cmd).toBe("unknown-agent");
  });

  it("normalizes agent name case and whitespace", async () => {
    expect(await resolveAcpxAgentCommand({ ...defaultParams, agent: "Gemini" })).toBe(
      "gemini --experimental-acp",
    );
    expect(await resolveAcpxAgentCommand({ ...defaultParams, agent: " CLAUDE " })).toBe(
      "npx -y @zed-industries/claude-agent-acp",
    );
  });
});
