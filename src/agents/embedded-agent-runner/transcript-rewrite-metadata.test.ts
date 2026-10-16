import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../sessions/session-manager.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

it.each([false, true])(
  "services event-loop work before publication and preserves intervening writes (%s)",
  async (interveningWrite) => {
    const manager = SessionManager.inMemory();
    const first = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
    const original = manager.getBranch();
    let observed: ReturnType<SessionManager["getBranch"]> | undefined;
    const prepare = manager.prepareTranscriptRewriteAsync.bind(manager);
    const preparation = vi
      .spyOn(manager, "prepareTranscriptRewriteAsync")
      .mockImplementation(async () => {
        const rewrite = await prepare();
        void nextTurn().then(() => {
          observed = manager.getBranch();
          if (interveningWrite) {
            manager.appendMessage({ role: "user", content: "newer input", timestamp: 3 });
          }
        });
        return rewrite;
      });
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 5));
    try {
      const result = rewriteTranscriptEntriesInSessionManager({
        sessionManager: manager,
        replacements: [
          { entryId: first, message: { role: "user", content: "replacement", timestamp: 1 } },
        ],
      });
      if (interveningWrite) {
        await expect(result).rejects.toThrow(
          "Session transcript changed before rewrite publication",
        );
        expect(
          manager
            .getBranch()
            .map((entry) =>
              entry.type === "message" && entry.message.role === "user"
                ? entry.message.content
                : null,
            ),
        ).toEqual(["original", "tail", "newer input"]);
      } else {
        await expect(result).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
        expect(
          manager
            .getBranch()
            .map((entry) =>
              entry.type === "message" && entry.message.role === "user"
                ? entry.message.content
                : null,
            ),
        ).toEqual(["replacement", "tail"]);
      }
      expect(observed).toEqual(original);
    } finally {
      clock.mockRestore();
      preparation.mockRestore();
      await nextTurn();
    }
  },
);

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
