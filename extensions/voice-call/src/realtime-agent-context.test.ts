// Voice Call tests cover realtime agent context plugin behavior.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const host = vi.hoisted((): { modernAvailable: boolean; rejection: Error | undefined } => ({
  modernAvailable: true,
  rejection: undefined,
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/realtime-bootstrap-context")>();
  return {
    ...actual,
    get resolveRealtimeVoiceAgentContextInstructions() {
      if (!host.modernAvailable) {
        return undefined;
      }
      const rejection = host.rejection;
      return rejection
        ? async () => {
            throw rejection;
          }
        : actual.resolveRealtimeVoiceAgentContextInstructions;
    },
  };
});

beforeEach(() => {
  host.modernAvailable = true;
  host.rejection = undefined;
});

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
  config.realtime = {
    ...config.realtime,
    ...overrides,
    agentContext: {
      ...config.realtime.agentContext,
      ...overrides?.agentContext,
      files: overrides?.agentContext?.files ?? config.realtime.agentContext.files,
    },
  };
  return config;
}

describe("buildRealtimeVoiceInstructions", () => {
  it("adds the opening question only for the explicit consent flow", async () => {
    const withoutConsent = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig(),
      coreConfig: {},
      agentId: "voice",
    });
    const withConsent = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({ consentWindow: { enabled: true, windowMs: 5000 } }),
      coreConfig: {},
      agentId: "voice",
    });

    expect(withoutConsent).not.toContain("Do you consent to this call being recorded?");
    expect(withConsent).toContain(
      'Your first spoken response must ask exactly, "Do you consent to this call being recorded?"',
    );
  });

  it("propagates a present modern composer's rejection without legacy fallback", async () => {
    const rejection = new Error("modern context rejected");
    host.rejection = rejection;
    await expect(
      buildRealtimeVoiceInstructions({
        baseInstructions: "Base voice instructions.",
        config: createConfig(),
        coreConfig: {},
        agentId: "voice",
      }),
    ).rejects.toBe(rejection);
  });

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

describe("published 2026.9.6 voice context", () => {
  beforeEach(() => {
    host.modernAvailable = false;
  });

  it("preserves identity, selected custom files and workspace containment", async () => {
    const parentDir = tempDirs.make("openclaw-legacy-voice-context-");
    const workspace = path.join(parentDir, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(parentDir, "OUTSIDE.md"), "OUTSIDE_CONTEXT");
    await writeFile(path.join(workspace, "VOICE.md"), "Custom voice preferences.");
    await writeFile(path.join(workspace, "SOUL.md"), "Workspace persona.");
    const instructions = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({
        consultPolicy: "substantive",
        agentContext: {
          enabled: true,
          includeIdentity: true,
          includeWorkspaceFiles: true,
          maxChars: 2000,
          files: ["VOICE.md", "SOUL.md", "../OUTSIDE.md", "missing.md"],
        },
      }),
      coreConfig: createCoreConfig(workspace),
      agentId: "voice",
    });
    expect(instructions).toContain("Consult behavior:");
    expect(instructions).toContain("OpenClaw agent voice context:");
    expect(instructions).toContain("- Agent id: voice");
    expect(instructions).toContain("- Name: Claw Voice");
    expect(instructions).toContain("- Theme: bright");
    expect(instructions).toContain("### VOICE.md\nCustom voice preferences.");
    expect(instructions).toContain("### SOUL.md\nWorkspace persona.");
    expect(instructions.indexOf("### VOICE.md")).toBeLessThan(instructions.indexOf("### SOUL.md"));
    expect(instructions).not.toContain("OUTSIDE_CONTEXT");
    expect(instructions).not.toContain("missing.md");
    expect(instructions).not.toContain("Agent context: You speak for an OpenClaw agent");
  });

  it.each([
    {
      enabled: false,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      identity: false,
      workspace: false,
    },
    {
      enabled: true,
      includeIdentity: true,
      includeWorkspaceFiles: false,
      identity: true,
      workspace: false,
    },
    {
      enabled: true,
      includeIdentity: false,
      includeWorkspaceFiles: true,
      identity: false,
      workspace: true,
    },
  ])("honors shipped context controls: %j", async (settings) => {
    const workspace = tempDirs.make("openclaw-legacy-voice-controls-");
    await writeFile(path.join(workspace, "SOUL.md"), "Legacy workspace persona.");
    const instructions = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({
        agentContext: {
          enabled: settings.enabled,
          includeIdentity: settings.includeIdentity,
          includeWorkspaceFiles: settings.includeWorkspaceFiles,
          maxChars: 2000,
          files: ["SOUL.md"],
        },
      }),
      coreConfig: createCoreConfig(workspace),
      agentId: "voice",
    });
    expect(instructions.includes("Configured identity:")).toBe(settings.identity);
    expect(instructions.includes("Legacy workspace persona.")).toBe(settings.workspace);
    expect(instructions.includes("OpenClaw agent voice context:")).toBe(settings.enabled);
    if (!settings.enabled) {
      expect(instructions).toBe("Base voice instructions.");
    }
  });

  it.each([200, 8])(
    "bounds the entire legacy capsule to %i characters, including its marker",
    async (maxChars) => {
      const workspace = tempDirs.make("openclaw-legacy-voice-budget-");
      await writeFile(path.join(workspace, "SOUL.md"), "Workspace persona. ".repeat(100));
      const base = "Base voice instructions.";
      const instructions = await buildRealtimeVoiceInstructions({
        baseInstructions: base,
        config: createConfig({
          agentContext: {
            enabled: true,
            includeIdentity: true,
            includeWorkspaceFiles: true,
            maxChars,
            files: ["SOUL.md"],
          },
        }),
        coreConfig: createCoreConfig(workspace),
        agentId: "voice",
      });
      expect(instructions.startsWith(`${base}\n\n`)).toBe(true);
      const capsule = instructions.slice(base.length + 2);
      expect(capsule.length).toBeGreaterThan(0);
      expect(capsule.length).toBeLessThanOrEqual(maxChars);
      if (maxChars === 200) {
        expect(capsule).toMatch(/\n\[truncated\]$/);
      }
    },
  );
});
