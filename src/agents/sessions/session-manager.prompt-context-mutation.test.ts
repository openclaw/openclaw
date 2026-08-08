import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptEventSync,
  loadTranscriptEvents,
  replaceTranscriptEventsSync,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION, type FileEntry, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeTarget(name: string) {
  const dir = tempDirs.make(`openclaw-prompt-context-${name}-`);
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntry(target, { sessionId: name, updatedAt: 1 });
  return { dir, target };
}

function managerWithParallelMessages(content: string, otherContent = content) {
  return SessionManager.fromEntries([
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "parallel",
      timestamp: "2026-08-08T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: "first",
      parentId: null,
      timestamp: "2026-08-08T00:00:01.000Z",
      message: { role: "user", content, timestamp: 1 },
    },
    {
      type: "message",
      id: "second",
      parentId: null,
      timestamp: "2026-08-08T00:00:02.000Z",
      message: { role: "user", content: otherContent, timestamp: 1 },
    },
  ]);
}

describe("SessionManager prompt-context mutation provenance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records canonical prompt changes with destructive per-attempt consumption", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("diagnostic", { ok: true });
    manager.appendSessionInfo("name");
    manager.resetLeaf();
    expect(manager.consumePromptContextMutation()).toBe("unchanged");

    const userId = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    expect(manager.consumePromptContextMutation()).toBe("changed");
    expect(manager.consumePromptContextMutation()).toBe("unchanged");
    manager.branch(userId);
    manager.appendThinkingLevelChange("high");
    expect(manager.consumePromptContextMutation()).toBe("changed");
    manager.appendThinkingLevelChange("high");
    const modelId = manager.appendModelChange("openai", "gpt-5.5");
    expect(manager.consumePromptContextMutation()).toBe("changed");
    manager.appendModelChange("openai", "gpt-5.5");
    manager.branchWithSummary(modelId, "");
    expect(manager.consumePromptContextMutation()).toBe("unchanged");
  });

  it("compares effective context rather than leaf identity", () => {
    const equivalent = managerWithParallelMessages("same");
    equivalent.branch("first");
    expect(equivalent.consumePromptContextMutation()).toBe("unchanged");

    const different = managerWithParallelMessages("old", "new");
    different.branch("first");
    expect(different.consumePromptContextMutation()).toBe("changed");
  });

  it("marks reload only when canonical prompt content changes", async () => {
    const { dir, target } = await makeTarget("reload");
    const manager = SessionManager.open(target, dir);
    const messageId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    expect(manager.consumePromptContextMutation()).toBe("changed");

    appendTranscriptEventSync(
      target,
      {
        type: "custom",
        id: "metadata",
        parentId: messageId,
        timestamp: "2026-08-08T00:00:02.000Z",
        customType: "diagnostic",
      },
      { appendIntent: "active-branch" },
    );
    manager.reloadPersistedTranscript();
    expect(manager.consumePromptContextMutation()).toBe("unchanged");

    const events = await loadTranscriptEvents(target);
    const message = (events as FileEntry[]).find(
      (entry) => entry.type === "message" && entry.id === messageId,
    );
    if (!message || message.type !== "message" || message.message.role !== "user") {
      throw new Error("expected persisted message");
    }
    message.message = { ...message.message, content: "replaced under the same id" };
    expect(replaceTranscriptEventsSync(target, events)).toBe(true);
    manager.reloadPersistedTranscript();
    expect(manager.consumePromptContextMutation()).toBe("changed");
  });

  it("restores state and provenance when persistence fails", async () => {
    const { dir, target } = await makeTarget("rollback");
    const manager = SessionManager.open(target, dir);
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
    expect(manager.consumePromptContextMutation()).toBe("changed");

    vi.spyOn(sessionAccessor, "appendTranscriptMessageSync").mockReturnValueOnce(undefined);
    expect(() => manager.appendMessage({ role: "user", content: "third", timestamp: 3 })).toThrow(
      "was not persisted",
    );
    expect(manager.consumePromptContextMutation()).toBe("unchanged");

    manager.appendLeafControl({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });
    expect(manager.consumePromptContextMutation()).toBe("changed");
    vi.spyOn(sessionAccessor, "replaceTranscriptEventsSync").mockReturnValueOnce(false);
    expect(() => manager.removeTrailingEntries((entry) => entry.id === secondId)).toThrow(
      "was not replaced",
    );
    expect({
      appendMode: manager.getAppendMode(),
      appendParentId: manager.getAppendParentId(),
      leafId: manager.getLeafId(),
    }).toEqual({ appendMode: "side", appendParentId: secondId, leafId: firstId });
    expect(manager.consumePromptContextMutation()).toBe("unchanged");
  });
});
