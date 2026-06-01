import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { undoLastSoulRule } from "./soul-auto-update.js";
import {
  buildReflectionPrompt,
  REFLECTION_PROMPT,
  shouldFireReflection,
  type SoulReflectionConfig,
} from "./soul-reflection.js";
import { createSoulUpdateTool } from "./tools/soul-update-tool.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

let workspaceDir: string;
let soulPath: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-soul-integration-"));
  soulPath = path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * End-to-end reflection flow without the model in the loop. Exercises every module that
 * makes up the feature — trigger detection, prompt build, tool execution, file write,
 * forced-notice payload, and undo — wired together the way the runner would call them.
 */
describe("soul reflection end-to-end flow", () => {
  const config: SoulReflectionConfig = { autoUpdate: true, reflectionTurnInterval: 5 };

  it("user says 'please stop using em-dashes' -> rule lands in SOUL.md and undo reverses it", async () => {
    await fsp.writeFile(
      soulPath,
      ["# SOUL.md", "", "## Vibe", "", "- Be terse.", ""].join("\n"),
      "utf-8",
    );
    const userMessage = "please stop using em-dashes";

    const trigger = shouldFireReflection({ userMessage, turnsSinceLast: 1, config });
    expect(trigger).not.toBeNull();
    if (!trigger) {
      return;
    }
    expect(trigger.kind).toBe("keyword");

    const prompt = buildReflectionPrompt({ trigger, recentUserMessage: userMessage });
    expect(prompt.startsWith(REFLECTION_PROMPT)).toBe(true);
    expect(prompt).toContain(userMessage);

    const tool = createSoulUpdateTool({ workspaceDir });
    const toolResult = await tool.execute("reflection-call-1", {
      rule: "Never use em-dashes.",
      evidence: "User: 'please stop using em-dashes'",
    });
    const payload = JSON.parse((toolResult.content[0] as { text: string }).text);
    expect(payload).toMatchObject({
      status: "appended",
      rule: "Never use em-dashes.",
      sectionCreated: true,
      notice: "Added to SOUL.md: 'Never use em-dashes.'",
    });

    const soul = await fsp.readFile(soulPath, "utf-8");
    expect(soul).toContain("## Auto-added");
    expect(soul).toContain("- Never use em-dashes.");
    expect(soul).toContain("evidence: User: 'please stop using em-dashes'");
    expect(soul).toContain("## Vibe");
    expect(soul).toContain("- Be terse.");

    const undone = await undoLastSoulRule(workspaceDir);
    expect(undone).toBe("Never use em-dashes.");
    const afterUndo = await fsp.readFile(soulPath, "utf-8");
    expect(afterUndo).not.toContain("- Never use em-dashes.");
    expect(afterUndo).toContain("- Be terse.");
  });

  it("interval-trigger flow on a neutral turn -> agent decides noop -> SOUL.md unchanged", async () => {
    const original = "# SOUL.md\n\nNothing fancy.\n";
    await fsp.writeFile(soulPath, original, "utf-8");

    const trigger = shouldFireReflection({
      userMessage: "ok, next file",
      turnsSinceLast: 5,
      config,
    });
    expect(trigger?.kind).toBe("interval");

    const tool = createSoulUpdateTool({ workspaceDir });
    const noopResult = await tool.execute("reflection-call-noop", { noop: true });
    expect(JSON.parse((noopResult.content[0] as { text: string }).text)).toEqual({
      status: "noop",
    });
    expect(await fsp.readFile(soulPath, "utf-8")).toBe(original);
  });

  it("two reflections on related phrasings -> second is rejected as duplicate", async () => {
    await fsp.writeFile(soulPath, "# SOUL.md\n", "utf-8");
    const tool = createSoulUpdateTool({ workspaceDir });

    await tool.execute("call-1", { rule: "Prefer one-line summaries." });
    const second = await tool.execute("call-2", {
      rule: "  PREFER  one-line   summaries. ",
    });
    expect(JSON.parse((second.content[0] as { text: string }).text)).toMatchObject({
      status: "duplicate",
    });
  });

  it("autoUpdate=false -> no trigger ever fires regardless of message or turn count", () => {
    expect(
      shouldFireReflection({
        userMessage: "please never do that again",
        turnsSinceLast: 100,
        config: { autoUpdate: false, reflectionTurnInterval: 5 },
      }),
    ).toBeNull();
  });
});
