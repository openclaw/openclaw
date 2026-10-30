import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { createExactAssistantMessage } from "../../config/sessions/transcript-message.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

function rewrite(manager: SessionManager, entryId: string) {
  return rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [{ entryId, message: { role: "user", content: "replacement", timestamp: 1 } }],
  });
}

const userContents = (manager: SessionManager) =>
  manager
    .getBranch()
    .map((entry) =>
      entry.type === "message" && entry.message.role === "user" ? entry.message.content : null,
    );

afterEach(async () => {
  vi.restoreAllMocks();
  await nextTurn();
});

it.each([false, true])(
  "yields before publication and preserves intervening writes (%s)",
  async (interveningWrite) => {
    const manager = SessionManager.inMemory();
    const first = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
    const original = manager.getBranch();
    let observed: ReturnType<SessionManager["getBranch"]> | undefined;
    const prepare = manager.prepareTranscriptRewriteAsync.bind(manager);
    vi.spyOn(manager, "prepareTranscriptRewriteAsync").mockImplementation(async () => {
      const prepared = await prepare();
      void nextTurn().then(() => {
        observed = manager.getBranch();
        if (interveningWrite) {
          manager.appendMessage({ role: "user", content: "newer input", timestamp: 3 });
        }
      });
      return prepared;
    });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 5));
    const result = rewrite(manager, first);
    if (interveningWrite) {
      await expect(result).rejects.toThrow("Session transcript changed before rewrite publication");
      expect(userContents(manager)).toEqual(["original", "tail", "newer input"]);
    } else {
      await expect(result).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
      expect(userContents(manager)).toEqual(["replacement", "tail"]);
    }
    expect(observed).toEqual(original);
  },
);

it("preserves labels targeting asynchronously replayed model and thinking entries", async () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
  const modelEntryId = await manager.appendModelChange("openai", "test-model");
  manager.appendLabelChange(modelEntryId, "model selection");
  const thinkingEntryId = await manager.appendThinkingLevelChange("high");
  manager.appendLabelChange(thinkingEntryId, "thinking selection");

  expect((await rewrite(manager, first)).changed).toBe(true);
  const branch = manager.getBranch();
  const types = ["message", "model_change", "label", "thinking_level_change", "label"];
  expect(branch.map((entry) => entry.type)).toEqual(types);
  for (const [type, label] of [
    ["model_change", "model selection"],
    ["thinking_level_change", "thinking selection"],
  ] as const) {
    const entry = branch.find((candidate) => candidate.type === type)!;
    expect(manager.getLabel(entry.id)).toBe(label);
    expect([modelEntryId, thinkingEntryId]).not.toContain(entry.id);
  }
});

it("remaps both placement references while retaining the original marker bytes", async () => {
  const manager = SessionManager.inMemory();
  const first = await manager.appendMessageAsync({
    role: "user",
    content: "original",
    timestamp: 1,
  });
  const pending = {
    ...createExactAssistantMessage({
      text: "background",
      provider: "openclaw",
      model: "automation-result",
    }),
    excludeFromContext: true,
    openclawModelPlacement: "pending",
  };
  const result = await manager.appendMessageAsync(pending);
  const preceding = await manager.appendMessageAsync(
    createExactAssistantMessage({ text: "signed output" }),
  );
  const data = { afterEntryId: preceding, resultEntryIds: [result] };
  const marker = await manager.appendCustomEntryAsync(
    BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
    data,
  );
  const original = JSON.stringify(manager.getEntry(marker));

  expect((await rewrite(manager, first!)).changed).toBe(true);
  const branch = manager.getBranch();
  expect(branch.at(-1)).toMatchObject({
    data: { afterEntryId: branch[2]?.id, resultEntryIds: [branch[1]?.id] },
  });
  expect(JSON.stringify(manager.getEntry(marker))).toBe(original);
  expect(
    manager.buildSessionContext().messages.map((message) => {
      assert(message.role === "user" || message.role === "assistant");
      return message.content;
    }),
  ).toEqual([
    "replacement",
    [{ type: "text", text: "signed output" }],
    [{ type: "text", text: "background" }],
  ]);
});
