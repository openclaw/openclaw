import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bootstrapFiles from "./bootstrap-files.js";
import * as identity from "./identity.js";
import {
  resolveRealtimeBootstrapContextInstructions,
  resolveRealtimeVoiceAgentContextInstructions,
} from "./realtime-bootstrap-context.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS as framing } from "./realtime-bootstrap-context.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workspaceDir: string;
let config: OpenClawConfig;
let params: { config: OpenClawConfig; agentId: string };
beforeEach(() => {
  workspaceDir = tempDirs.make("openclaw-realtime-bootstrap-");
  config = {
    agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
  };
  params = { config, agentId: "main" };
});
afterEach(() => vi.restoreAllMocks());

async function writeFiles(files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      fs.writeFile(path.join(workspaceDir, name), content),
    ),
  );
}

describe("resolveRealtimeBootstrapContextInstructions", () => {
  it.each([1, 1_000])(
    "formats and bounds profile files with %i identity lines without exposing paths",
    async (lines) => {
      await writeFiles({
        "IDENTITY.md": "Name: Wilfred\n".repeat(lines),
        "USER.md": "User likes concise answers.\n",
        "SOUL.md": "Warm and dry.\n",
        "AGENTS.md": "Do not load me here.\n",
      });
      const instructions = await resolveRealtimeBootstrapContextInstructions({
        ...params,
        sessionKey: "agent:main:discord:channel:1001",
        files: lines === 1 ? undefined : ["IDENTITY.md", "USER.md", "SOUL.md"],
      });
      for (const text of [
        "OpenClaw realtime voice profile context",
        "### IDENTITY.md",
        "Name: Wilfred",
        "### USER.md",
        "User likes concise answers.",
        "### SOUL.md",
        "Warm and dry.",
      ]) {
        expect(instructions).toContain(text);
      }
      for (const text of [
        "AGENTS.md",
        "Do not load me here.",
        "openclaw_agent_consult",
        workspaceDir,
      ]) {
        expect(instructions).not.toContain(text);
      }
      expect(instructions?.length).toBeLessThanOrEqual(12_000);
    },
  );

  it("includes safe extra files in requested order and skips missing or escaping paths", async () => {
    const parentDir = workspaceDir;
    workspaceDir = path.join(parentDir, "workspace");
    config.agents!.defaults!.workspace = workspaceDir;
    await fs.mkdir(path.join(workspaceDir, "context"), { recursive: true });
    await fs.writeFile(path.join(parentDir, "x"), "Outside context must stay private.");
    await writeFiles({ "IDENTITY.md": "Name: Wilfred", "context/brief.md": "Project briefing." });
    const warnings: string[] = [];
    const instructions = await resolveRealtimeBootstrapContextInstructions({
      ...params,
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

  it("returns undefined when no requested profile files exist", async () => {
    await expect(
      resolveRealtimeBootstrapContextInstructions({ ...params, files: ["IDENTITY.md", "USER.md"] }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveRealtimeVoiceAgentContextInstructions", () => {
  it.each([false, true])(
    "preserves framing and profile with identity failure=%s",
    async (failIdentity) => {
      await writeFiles({ "SOUL.md": "Warm and dry." });
      vi.spyOn(identity, "resolveAgentIdentity").mockImplementation(() => {
        if (failIdentity) {
          throw new Error("identity unavailable");
        }
        return {
          name: " Wilfred ",
          emoji: "🦞",
          vibe: " dry ",
          theme: "friendly",
          creature: "lobster",
        };
      });
      const warn = vi.fn();
      const instructions = await resolveRealtimeVoiceAgentContextInstructions({
        ...params,
        includeIdentity: true,
        warn,
      });
      expect(instructions.startsWith(framing)).toBe(true);
      expect(instructions.split(framing)).toHaveLength(2);
      expect(instructions).toContain("### SOUL.md\nWarm and dry.");
      if (failIdentity) {
        expect(instructions).not.toContain("Configured identity:");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("identity unavailable"));
      } else {
        expect(
          instructions.startsWith(
            `${framing}\n\nConfigured identity:\n- Name: Wilfred\n- Emoji: 🦞\n- Vibe: dry\n- Theme: friendly\n- Creature/persona: lobster\n\nOpenClaw realtime voice profile context:`,
          ),
        ).toBe(true);
      }
    },
  );

  it.each(["disabled", "unavailable"] as const)(
    "preserves framing and optional identity when profile is %s",
    async (profile) => {
      const warn = vi.fn();
      const files = profile === "disabled" ? [] : undefined;
      if (profile === "unavailable") {
        vi.spyOn(bootstrapFiles, "resolveBootstrapFilesForRun").mockRejectedValue(
          new Error("profile unavailable"),
        );
      }
      config.agents!.list![0]!.identity = { name: "Wilfred" };
      expect(await resolveRealtimeVoiceAgentContextInstructions({ ...params, files, warn })).toBe(
        framing,
      );
      if (profile === "unavailable") {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("profile unavailable"));
      } else {
        config.agents!.list![0]!.identity = { name: " ", emoji: "" };
        await expect(
          resolveRealtimeBootstrapContextInstructions({ ...params, files }),
        ).resolves.toBeUndefined();
      }
      expect(
        await resolveRealtimeVoiceAgentContextInstructions({
          ...params,
          files,
          includeIdentity: true,
          warn,
        }),
      ).toBe(
        profile === "disabled" ? framing : `${framing}\n\nConfigured identity:\n- Name: Wilfred`,
      );
    },
  );

  it("bounds the complete profile block without cutting the paragraph or UTF-16 pairs", async () => {
    await writeFiles({ "brief.md": "🚀".repeat(1_000) });
    const instructions = await resolveRealtimeVoiceAgentContextInstructions({
      ...params,
      files: ["brief.md"],
      maxChars: 400,
    });
    expect(instructions.startsWith(`${framing}\n\n`)).toBe(true);
    const profile = instructions.slice(framing.length + 2);
    expect(profile).toContain("### brief.md");
    expect(profile.length).toBeLessThanOrEqual(400);
    expect(profile.isWellFormed()).toBe(true);
    expect(profile).toContain("truncated");
  });
});
