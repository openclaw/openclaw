import { expect, it } from "vitest";
import { SessionManager } from "../sessions/session-manager.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

it("preserves labels targeting asynchronously replayed model and thinking entries", async () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
  const modelEntryId = await manager.appendModelChange("openai", "test-model");
  manager.appendLabelChange(modelEntryId, "model selection");
  const thinkingEntryId = await manager.appendThinkingLevelChange("high");
  manager.appendLabelChange(thinkingEntryId, "thinking selection");

  const rewritten = await rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [
      { entryId: first, message: { role: "user", content: "replacement", timestamp: 1 } },
    ],
  });

  expect(rewritten.changed).toBe(true);
  const branch = manager.getBranch();
  expect(branch.map((entry) => entry.type)).toEqual([
    "message",
    "model_change",
    "label",
    "thinking_level_change",
    "label",
  ]);
  for (const [type, label] of [
    ["model_change", "model selection"],
    ["thinking_level_change", "thinking selection"],
  ] as const) {
    const entry = branch.find((candidate) => candidate.type === type);
    if (!entry) {
      throw new Error(`Missing replayed ${type}`);
    }
    expect(manager.getLabel(entry.id)).toBe(label);
    expect([modelEntryId, thinkingEntryId]).not.toContain(entry.id);
  }
});
