import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyContextLayering,
  buildRollingContextSummary,
  isContextLayeringEnabled,
  loadRollingContextSummary,
  resolveHotContextTurns,
  resolveRollingSummaryPath,
  saveRollingContextSummary,
  updateRollingContextSummaryForTurn,
} from "./context-layering.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (!tempDir) {
    return;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("context layering flags", () => {
  it("enables context layering for truthy env values", () => {
    expect(isContextLayeringEnabled({ OPENCLAW_CONTEXT_LAYERS: "1" })).toBe(true);
    expect(isContextLayeringEnabled({ OPENCLAW_CONTEXT_LAYERS: "true" })).toBe(true);
    expect(isContextLayeringEnabled({ OPENCLAW_CONTEXT_LAYERS: "on" })).toBe(true);
    expect(isContextLayeringEnabled({ OPENCLAW_CONTEXT_LAYERS: "0" })).toBe(false);
  });

  it("resolves hot turn count from env with sane fallback", () => {
    expect(resolveHotContextTurns({ OPENCLAW_CONTEXT_HOT_TURNS: "4" })).toBe(4);
    expect(resolveHotContextTurns({ OPENCLAW_CONTEXT_HOT_TURNS: "0" })).toBe(8);
    expect(resolveHotContextTurns({ OPENCLAW_CONTEXT_HOT_TURNS: "" })).toBe(8);
  });
});

describe("rolling summary persistence", () => {
  it("reads and writes rolling summary sidecar", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-layering-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const summaryPath = resolveRollingSummaryPath(sessionFile);

    await saveRollingContextSummary(sessionFile, {
      schemaVersion: 1,
      updatedAt: 123,
      goal: "Ship fallback improvements",
      constraints: ["keep defaults unchanged"],
      completed: ["updated tests"],
      pending: ["open PR"],
      next: ["write changelog"],
    });

    const loaded = await loadRollingContextSummary(sessionFile);
    expect(loaded?.goal).toBe("Ship fallback improvements");
    expect(summaryPath.endsWith("session.rolling-summary.json")).toBe(true);
  });

  it("updates summary with latest assistant turn", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-layering-"));
    const sessionFile = path.join(tempDir, "session.jsonl");

    const updated = await updateRollingContextSummaryForTurn({
      sessionFile,
      prompt: "Optimize context behavior",
      assistantReply: "Next: add fallback tests",
      now: 999,
    });

    expect(updated.goal).toContain("Optimize context behavior");
    expect(updated.completed[0]).toContain("Last turn outcome");
    expect(updated.next[0]?.toLowerCase()).toContain("next");
  });
});

describe("applyContextLayering", () => {
  it("replaces cold history with warm summary and keeps hot turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "u1" } as AgentMessage,
      { role: "assistant", content: "a1" } as unknown as AgentMessage,
      { role: "user", content: "u2" } as AgentMessage,
      { role: "assistant", content: "a2" } as unknown as AgentMessage,
      { role: "user", content: "u3" } as AgentMessage,
      { role: "assistant", content: "a3" } as unknown as AgentMessage,
    ];

    const layered = applyContextLayering({
      messages,
      summary: buildRollingContextSummary({
        existing: null,
        prompt: "Deliver context layering",
        assistantReply: "done",
      }),
      keepHotUserTurns: 2,
    });

    expect(layered.applied).toBe(true);
    expect(layered.coldMessageCount).toBe(2);
    expect(layered.messages[0]?.role).toBe("system");
    const firstHot = layered.messages[1] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstHot?.role).toBe("user");
    expect(firstHot?.content).toBe("u2");
  });

  it("keeps original messages when summary missing", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "u1" } as AgentMessage];
    const layered = applyContextLayering({
      messages,
      summary: null,
      keepHotUserTurns: 1,
    });

    expect(layered.applied).toBe(false);
    expect(layered.messages).toEqual(messages);
  });
});
