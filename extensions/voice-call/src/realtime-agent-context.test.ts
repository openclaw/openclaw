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

function buildInstructions(
  workspace: string,
  context: Partial<VoiceCallConfig["realtime"]["agentContext"]> = {},
  consultPolicy?: VoiceCallConfig["realtime"]["consultPolicy"],
) {
  const config = createVoiceCallBaseConfig();
  config.realtime.agentContext = { ...config.realtime.agentContext, ...context };
  if (consultPolicy) {
    config.realtime.consultPolicy = consultPolicy;
  }
  return buildRealtimeVoiceInstructions({
    baseInstructions: "Base voice instructions.",
    config,
    coreConfig: createCoreConfig(workspace),
    agentId: "voice",
  });
}

describe("buildRealtimeVoiceInstructions", () => {
  it("propagates a present modern composer's rejection without legacy fallback", async () => {
    const rejection = new Error("modern context rejected");
    host.rejection = rejection;
    await expect(buildInstructions(tempDirs.make("openclaw-voice-context-"))).rejects.toBe(
      rejection,
    );
  });

  it.each([true, false])(
    "preserves identity, selected files and workspace containment (modern host: %s)",
    async (modern) => {
      host.modernAvailable = modern;
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
          includeIdentity: true,
          includeWorkspaceFiles: true,
          maxChars: 2000,
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
      if (modern) {
        expect(instructions).toContain("Agent context: You speak for an OpenClaw agent");
        expect(instructions.match(/Agent context:/g)).toHaveLength(1);
      } else {
        expect(instructions).toContain("OpenClaw agent voice context:");
        expect(instructions).toContain("- Agent id: voice");
        expect(instructions).toContain("### VOICE.md\nCustom voice preferences.");
        expect(instructions.indexOf("### VOICE.md")).toBeLessThan(
          instructions.indexOf("### SOUL.md"),
        );
        expect(instructions).not.toContain("missing.md");
        expect(instructions).not.toContain("Agent context: You speak for an OpenClaw agent");
      }
    },
  );

  it.each([
    { modern: true, enabled: false, includeIdentity: true, includeWorkspaceFiles: true },
    { modern: true, enabled: true, includeIdentity: false, includeWorkspaceFiles: false },
    { modern: true, enabled: true, includeIdentity: true, includeWorkspaceFiles: false },
    { modern: true, enabled: true, includeIdentity: false, includeWorkspaceFiles: true },
    { modern: false, enabled: false, includeIdentity: true, includeWorkspaceFiles: true },
    { modern: false, enabled: true, includeIdentity: true, includeWorkspaceFiles: false },
    { modern: false, enabled: true, includeIdentity: false, includeWorkspaceFiles: true },
  ])("honors context controls: %j", async ({ modern, ...settings }) => {
    host.modernAvailable = modern;
    const workspace = tempDirs.make("openclaw-voice-controls-");
    await writeFile(path.join(workspace, "SOUL.md"), "Workspace persona.");
    const instructions = await buildInstructions(workspace, {
      ...settings,
      maxChars: 2000,
      files: ["SOUL.md"],
    });
    expect(instructions.includes("Configured identity:")).toBe(
      settings.enabled && settings.includeIdentity,
    );
    expect(instructions.includes("Workspace persona.")).toBe(
      settings.enabled && settings.includeWorkspaceFiles,
    );
    if (modern) {
      expect(instructions).toMatch(/^Base voice instructions\.\n\nAgent context:/);
      expect(instructions.match(/Agent context:/g)).toHaveLength(1);
    } else {
      expect(instructions.includes("OpenClaw agent voice context:")).toBe(settings.enabled);
      if (!settings.enabled) {
        expect(instructions).toBe("Base voice instructions.");
      }
    }
  });

  it.each([200, 8])(
    "bounds the entire legacy capsule to %i characters, including its marker",
    async (maxChars) => {
      host.modernAvailable = false;
      const workspace = tempDirs.make("openclaw-legacy-voice-budget-");
      await writeFile(path.join(workspace, "SOUL.md"), "Workspace persona. ".repeat(100));
      const instructions = await buildInstructions(workspace, {
        enabled: true,
        includeIdentity: true,
        includeWorkspaceFiles: true,
        maxChars,
        files: ["SOUL.md"],
      });
      const base = "Base voice instructions.";
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
