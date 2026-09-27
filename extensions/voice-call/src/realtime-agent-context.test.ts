// Voice Call tests cover realtime agent context plugin behavior.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createCoreConfig(workspace: string): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "voice",
          workspace,
          identity: {
            name: "Claw Voice",
            emoji: ":claw:",
            theme: "bright",
          },
        },
      ],
    },
  };
}

function createConfig(overrides?: Partial<VoiceCallConfig["realtime"]>): VoiceCallConfig {
  const config = createVoiceCallBaseConfig();
  config.agentId = "voice";
  config.realtime.enabled = true;
  config.realtime.instructions = "Base voice instructions.";
  config.realtime = {
    ...config.realtime,
    ...overrides,
    fastContext: {
      ...config.realtime.fastContext,
      ...overrides?.fastContext,
      sources: overrides?.fastContext?.sources ?? config.realtime.fastContext.sources,
    },
    agentContext: {
      ...config.realtime.agentContext,
      ...overrides?.agentContext,
      files: overrides?.agentContext?.files ?? config.realtime.agentContext.files,
    },
    tools: overrides?.tools ?? config.realtime.tools,
    providers: overrides?.providers ?? config.realtime.providers,
  };
  return config;
}

describe("buildRealtimeVoiceInstructions", () => {
  it("injects bounded identity and workspace context", async () => {
    const workspaceDir = tempDirs.make("openclaw-voice-context-");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Stay quick, direct, and warm.\n");
    await writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Claw Voice\nVibe: snappy\n");
    await writeFile(path.join(workspaceDir, "SECRET.md"), "do not include\n");

    const coreConfig = createCoreConfig(workspaceDir);

    const instructions = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({
        consultPolicy: "substantive",
        agentContext: {
          enabled: true,
          maxChars: 2000,
          includeIdentity: true,
          includeWorkspaceFiles: true,
          files: ["SOUL.md", "IDENTITY.md", "../SECRET.md"],
        },
      }),
      coreConfig,
      agentId: "voice",
    });

    expect(instructions).toContain("Agent context: You speak for an OpenClaw agent");
    expect(instructions.match(/Agent context:/g)).toHaveLength(1);
    expect(instructions).toContain("Consult behavior:");
    expect(instructions).toContain("Call openclaw_agent_consult before answering requests");
    expect(instructions).toContain("- Name: Claw Voice");
    expect(instructions).toContain("- Theme: bright");
    expect(instructions).toContain("### SOUL.md");
    expect(instructions).toContain("Stay quick, direct, and warm.");
    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).not.toContain("do not include");
  });

  it.each([
    {
      enabled: false,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      identity: false,
      profile: false,
    },
    {
      enabled: true,
      includeIdentity: false,
      includeWorkspaceFiles: false,
      identity: false,
      profile: false,
    },
    {
      enabled: true,
      includeIdentity: true,
      includeWorkspaceFiles: false,
      identity: true,
      profile: false,
    },
    {
      enabled: true,
      includeIdentity: false,
      includeWorkspaceFiles: true,
      identity: false,
      profile: true,
    },
  ])("honors optional context controls: %j", async (settings) => {
    const workspaceDir = tempDirs.make("openclaw-voice-context-");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Workspace persona.");
    const instructions = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({
        agentContext: {
          enabled: settings.enabled,
          includeIdentity: settings.includeIdentity,
          includeWorkspaceFiles: settings.includeWorkspaceFiles,
          maxChars: 6000,
          files: ["SOUL.md"],
        },
      }),
      coreConfig: createCoreConfig(workspaceDir),
      agentId: "voice",
    });
    expect(instructions).toMatch(/^Base voice instructions\.\n\nAgent context:/);
    expect(instructions.match(/Agent context:/g)).toHaveLength(1);
    expect(instructions.includes("Configured identity:")).toBe(settings.identity);
    expect(instructions.includes("Workspace persona.")).toBe(settings.profile);
  });
});
