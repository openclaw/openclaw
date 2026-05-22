import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../src/plugin-sdk/plugin-entry.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import meetingNotesPlugin from "./index.js";

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
}

function createHarness(stateDir: string) {
  const providers: unknown[] = [];
  const tools: AnyAgentTool[] = [];
  const api = createTestPluginApi({
    pluginConfig: {},
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    } as never,
    registerMeetingNotesSourceProvider: (provider) => providers.push(provider),
    registerTool: (tool) => tools.push(tool as AnyAgentTool),
  });
  meetingNotesPlugin.register(api);
  return { providers, tool: tools[0] };
}

describe("meeting-notes plugin", () => {
  it("registers the manual transcript source and tool", async () => {
    const stateDir = await makeStateDir();
    const { providers, tool } = createHarness(stateDir);

    expect(providers).toHaveLength(1);
    expect(tool?.name).toBe("meeting_notes");
  });

  it("imports a speaker transcript and writes summary artifacts", async () => {
    const stateDir = await makeStateDir();
    const { tool } = createHarness(stateDir);

    const result = await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "design-review",
        title: "Design review",
        transcript:
          "Alex: We decided to ship Discord first.\nSam: Action item: add Slack import later.",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: {
        sessionId: "design-review",
        utteranceCount: 2,
      },
    });
    await expect(
      fs.readFile(path.join(stateDir, "meeting-notes", "design-review", "summary.md"), "utf8"),
    ).resolves.toContain("Action item: add Slack import later.");
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", "design-review", "transcript.jsonl"),
        "utf8",
      ),
    ).resolves.toContain("Alex");
  });
});
