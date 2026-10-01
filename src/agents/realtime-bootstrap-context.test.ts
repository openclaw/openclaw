import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bootstrapFiles from "./bootstrap-files.js";
import * as identity from "./identity.js";
import {
  resolveRealtimeBootstrapContextInstructions,
  resolveRealtimeVoiceAgentContextInstructions,
} from "./realtime-bootstrap-context.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "./realtime-bootstrap-context.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeWorkspace(): string {
  return tempDirs.make("openclaw-realtime-bootstrap-");
}

function makeConfig(workspaceDir: string): OpenClawConfig {
  // Bootstrap context resolves files through the configured default agent workspace.
  return {
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", default: true }],
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("resolveRealtimeBootstrapContextInstructions", () => {
  it("formats the default profile bootstrap files without exposing local paths", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Wilfred\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "User likes concise answers.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Do not load me here.\n", "utf8");

    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1001",
    });

    expect(instructions).toContain("OpenClaw realtime voice profile context");
    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).toContain("Name: Wilfred");
    expect(instructions).toContain("### USER.md");
    expect(instructions).toContain("User likes concise answers.");
    expect(instructions).toContain("### SOUL.md");
    expect(instructions).toContain("Warm and dry.");
    expect(instructions).not.toContain("AGENTS.md");
    expect(instructions).not.toContain("Do not load me here.");
    expect(instructions).not.toContain("openclaw_agent_consult");
    expect(instructions).not.toContain(workspaceDir);
  });

  it("includes safe extra files in requested order and skips missing or escaping paths", async () => {
    const parentDir = makeWorkspace();
    const workspaceDir = path.join(parentDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "context"), { recursive: true });
    await fs.writeFile(path.join(parentDir, "x"), "Outside context must stay private.");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Wilfred");
    await fs.writeFile(path.join(workspaceDir, "context", "brief.md"), "Project briefing.");
    const warnings: string[] = [];
    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      files: ["context/brief.md", "../x", "missing.md", "IDENTITY.md"],
      warn: (message) => warnings.push(message),
    });

    expect(instructions).toContain("### brief.md\nProject briefing.");
    expect(instructions).toContain("### IDENTITY.md\nName: Wilfred");
    expect(instructions!.indexOf("Project briefing.")).toBeLessThan(
      instructions!.indexOf("Name: Wilfred"),
    );
    expect(instructions).not.toContain("Outside context");
    expect(instructions).not.toContain("missing.md");
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('skipping realtime context file "../x"')]),
    );
  });

  it("keeps the complete injected instruction text within the default budget", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "IDENTITY.md"),
      "Name: Wilfred\n".repeat(1_000),
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "User likes concise answers.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.\n", "utf8");

    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      files: ["IDENTITY.md", "USER.md", "SOUL.md"],
    });

    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions?.length).toBeLessThanOrEqual(12_000);
  });

  it("returns undefined when no requested profile files exist", async () => {
    const workspaceDir = makeWorkspace();

    await expect(
      resolveRealtimeBootstrapContextInstructions({
        config: makeConfig(workspaceDir),
        agentId: "main",
        files: ["IDENTITY.md", "USER.md"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveRealtimeVoiceAgentContextInstructions", () => {
  it("places the paragraph exactly once before configured identity and profile files", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.");
    const config = makeConfig(workspaceDir);
    vi.spyOn(identity, "resolveAgentIdentity").mockImplementation(() => ({
      name: " Wilfred ",
      emoji: "🦞",
      vibe: " dry ",
      theme: "friendly",
      creature: "lobster",
    }));
    const instructions = await resolveRealtimeVoiceAgentContextInstructions({
      config,
      agentId: "main",
      includeIdentity: true,
    });
    expect(
      instructions.startsWith(
        `${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nConfigured identity:\n- Name: Wilfred\n- Emoji: 🦞\n- Vibe: dry\n- Theme: friendly\n- Creature/persona: lobster\n\nOpenClaw realtime voice profile context:`,
      ),
    ).toBe(true);
    expect(instructions.split(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS)).toHaveLength(2);
    expect(instructions).toContain("### SOUL.md\nWarm and dry.");
  });

  it("keeps the paragraph when profile files are disabled and identity is not selected or empty", async () => {
    const config = makeConfig(makeWorkspace());
    config.agents!.list![0]!.identity = { name: "Wilfred" };
    expect(
      await resolveRealtimeVoiceAgentContextInstructions({ config, agentId: "main", files: [] }),
    ).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
    config.agents!.list![0]!.identity = { name: " ", emoji: "" };
    expect(
      await resolveRealtimeVoiceAgentContextInstructions({
        config,
        agentId: "main",
        files: [],
        includeIdentity: true,
      }),
    ).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
    expect(
      await resolveRealtimeBootstrapContextInstructions({ config, agentId: "main", files: [] }),
    ).toBeUndefined();
  });

  it("warns on profile failure without losing the paragraph or a loaded identity", async () => {
    const config = makeConfig(makeWorkspace());
    const warn = vi.fn();
    vi.spyOn(bootstrapFiles, "resolveBootstrapFilesForRun").mockRejectedValue(
      new Error("profile unavailable"),
    );
    expect(
      await resolveRealtimeVoiceAgentContextInstructions({ config, agentId: "main", warn }),
    ).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("profile unavailable"));
    config.agents!.list![0]!.identity = { name: "Wilfred" };
    expect(
      await resolveRealtimeVoiceAgentContextInstructions({
        config,
        agentId: "main",
        includeIdentity: true,
        warn,
      }),
    ).toBe(`${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\nConfigured identity:\n- Name: Wilfred`);
  });

  it("warns on identity failure and still includes the profile", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.");
    vi.spyOn(identity, "resolveAgentIdentity").mockImplementation(() => {
      throw new Error("identity unavailable");
    });
    const warn = vi.fn();
    const instructions = await resolveRealtimeVoiceAgentContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      includeIdentity: true,
      warn,
    });
    expect(instructions.startsWith(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS)).toBe(true);
    expect(instructions).not.toContain("Configured identity:");
    expect(instructions).toContain("Warm and dry.");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("identity unavailable"));
  });

  it("bounds the complete profile block without cutting the paragraph or UTF-16 pairs", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "brief.md"), "🚀".repeat(1_000));
    const instructions = await resolveRealtimeVoiceAgentContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      files: ["brief.md"],
      maxChars: 400,
    });
    expect(instructions.startsWith(`${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}\n\n`)).toBe(true);
    const profile = instructions.slice(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS.length + 2);
    expect(profile).toContain("### brief.md");
    expect(profile.length).toBeLessThanOrEqual(400);
    expect(profile.isWellFormed()).toBe(true);
    expect(profile).toContain("truncated");
  });
});
