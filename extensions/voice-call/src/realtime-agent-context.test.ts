import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRealtimeVoiceAgentContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/realtime-bootstrap-context")>();
  return {
    ...actual,
    resolveRealtimeVoiceAgentContextInstructions: vi.fn(
      actual.resolveRealtimeVoiceAgentContextInstructions,
    ),
  };
});

const identity = { name: "Claw Voice", emoji: ":claw:", theme: "bright" };

function buildInstructions(
  workspace: string,
  context: Partial<VoiceCallConfig["realtime"]["agentContext"]> = {},
  consultPolicy?: VoiceCallConfig["realtime"]["consultPolicy"],
) {
  const config = createVoiceCallBaseConfig();
  config.realtime.agentContext = {
    ...config.realtime.agentContext,
    maxChars: 2000,
    files: ["SOUL.md"],
    ...context,
  };
  config.realtime.consultPolicy = consultPolicy ?? config.realtime.consultPolicy;
  return buildRealtimeVoiceInstructions({
    baseInstructions: "Base voice instructions.",
    config,
    coreConfig: { agents: { entries: { voice: { workspace, identity } } } },
    agentId: "voice",
  });
}

describe("buildRealtimeVoiceInstructions", () => {
  it("propagates the host composer's rejection", async () => {
    const rejection = new Error("modern context rejected");
    vi.mocked(resolveRealtimeVoiceAgentContextInstructions).mockRejectedValueOnce(rejection);
    const workspace = tempDirs.make("openclaw-voice-context-");
    await expect(buildInstructions(workspace)).rejects.toBe(rejection);
  });

  it("preserves identity, selected files and workspace containment", async () => {
    const parentDir = tempDirs.make("openclaw-voice-context-");
    const workspace = path.join(parentDir, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(parentDir, "OUTSIDE.md"), "OUTSIDE_CONTEXT");
    await writeFile(path.join(workspace, "SOUL.md"), "Stay quick, direct, and warm.\n");
    await writeFile(path.join(workspace, "IDENTITY.md"), "Name: Claw Voice\nVibe: snappy\n");
    await writeFile(path.join(workspace, "VOICE.md"), "Custom voice preferences.");
    const instructions = await buildInstructions(
      workspace,
      {
        enabled: true,
        files: ["VOICE.md", "SOUL.md", "IDENTITY.md", "../OUTSIDE.md", "missing.md"],
      },
      "substantive",
    );
    expect(instructions).toContain("Consult behavior:");
    expect(instructions).toContain("Call openclaw_agent_consult before answering requests");
    expect(instructions).toContain("- Name: Claw Voice");
    expect(instructions).toContain("- Theme: bright");
    expect(instructions).toContain("### SOUL.md\nStay quick, direct, and warm.");
    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).not.toContain("OUTSIDE_CONTEXT");
    expect(instructions).toContain("Agent context: You speak for an OpenClaw agent");
    expect(instructions.match(/Agent context:/g)).toHaveLength(1);
  });

  it.each([
    { enabled: false, includeIdentity: true, includeWorkspaceFiles: true },
    { enabled: true, includeIdentity: false, includeWorkspaceFiles: false },
    { enabled: true, includeIdentity: true, includeWorkspaceFiles: false },
    { enabled: true, includeIdentity: false, includeWorkspaceFiles: true },
  ])("honors context controls: %j", async (settings) => {
    const workspace = tempDirs.make("openclaw-voice-controls-");
    await writeFile(path.join(workspace, "SOUL.md"), "Workspace persona.");
    const instructions = await buildInstructions(workspace, settings);
    expect(instructions.includes("Configured identity:")).toBe(
      settings.enabled && settings.includeIdentity,
    );
    expect(instructions.includes("Workspace persona.")).toBe(
      settings.enabled && settings.includeWorkspaceFiles,
    );
    expect(instructions).toMatch(/^Base voice instructions\.\n\nAgent context:/);
    expect(instructions.match(/Agent context:/g)).toHaveLength(1);
  });
});
