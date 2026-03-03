import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeAgentPersonaToClaudeMd } from "./acp-persona-bridge.js";

// Minimal config type stub — only the fields we need
type MinimalConfig = {
  agents?: {
    list?: Array<{ id: string; workspace?: string }>;
  };
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(import.meta.dirname ?? __dirname, ".test-persona-bridge-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeWorkspaceDirs() {
  const agentWorkspace = path.join(tmpDir, "agent-workspace");
  const sessionCwd = path.join(tmpDir, "session-cwd");
  return { agentWorkspace, sessionCwd };
}

async function setup(files: Record<string, string>) {
  const { agentWorkspace, sessionCwd } = makeWorkspaceDirs();
  await fs.mkdir(agentWorkspace, { recursive: true });
  await fs.mkdir(sessionCwd, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(agentWorkspace, name), content, "utf-8");
  }

  const cfg: MinimalConfig = {
    agents: {
      list: [{ id: "test-agent", workspace: agentWorkspace }],
    },
  };

  return { cfg, agentWorkspace, sessionCwd };
}

describe("bridgeAgentPersonaToClaudeMd", () => {
  it("bridges SOUL.md into CLAUDE.md", async () => {
    const { cfg, sessionCwd } = await setup({
      "SOUL.md": "# Test Agent\nI am a test agent.",
    });

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(true);
    const content = await fs.readFile(path.join(sessionCwd, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Agent Persona Bridge");
    expect(content).toContain("I am a test agent");
    expect(content).toContain("SOUL.md");
  });

  it("bridges AGENTS.md into CLAUDE.md", async () => {
    const { cfg, sessionCwd } = await setup({
      "AGENTS.md": "# Workspace Rules\nFollow these rules.",
    });

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(true);
    const content = await fs.readFile(path.join(sessionCwd, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Follow these rules");
    expect(content).toContain("AGENTS.md");
  });

  it("bridges both SOUL.md and AGENTS.md", async () => {
    const { cfg, sessionCwd } = await setup({
      "SOUL.md": "# Identity\nI am İbo.",
      "AGENTS.md": "# Rules\nCode first.",
    });

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(true);
    const content = await fs.readFile(path.join(sessionCwd, "CLAUDE.md"), "utf-8");
    expect(content).toContain("I am İbo");
    expect(content).toContain("Code first");
  });

  it("does not overwrite existing CLAUDE.md", async () => {
    const { cfg, sessionCwd } = await setup({
      "SOUL.md": "# Identity\nShould not appear.",
    });

    await fs.writeFile(path.join(sessionCwd, "CLAUDE.md"), "existing content", "utf-8");

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(false);
    expect(result.reason).toBe("existing-claude-md");
    const content = await fs.readFile(path.join(sessionCwd, "CLAUDE.md"), "utf-8");
    expect(content).toBe("existing content");
  });

  it("returns no-persona-files when neither file exists", async () => {
    const { cfg, sessionCwd } = await setup({});

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(false);
    expect(result.reason).toBe("no-persona-files");
  });

  it("skips empty persona files", async () => {
    const { cfg, sessionCwd } = await setup({
      "SOUL.md": "   ",
      "AGENTS.md": "",
    });

    const result = await bridgeAgentPersonaToClaudeMd({
      cfg: cfg as any,
      agentId: "test-agent",
      sessionCwd,
    });

    expect(result.bridged).toBe(false);
    expect(result.reason).toBe("no-persona-files");
  });
});
