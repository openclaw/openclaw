// Terminal anchor helper tests cover the leaf-walk for durable context-engine anchors.
import { describe, expect, it } from "vitest";
import { resolveTerminalMessageEntryId } from "./attempt-terminal-anchor.js";

type FakeEntry = { id: string; parentId: string | null; type: string };

function managerFor(entries: FakeEntry[], leafId: string | null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getEntry: (id: string) => byId.get(id),
  };
}

describe("resolveTerminalMessageEntryId", () => {
  const base = { id: "assistant-1", parentId: null, type: "message" };
  const marker = { id: "marker-1", parentId: "assistant-1", type: "custom" };
  const snapshot = { id: "snapshot-1", parentId: "marker-1", type: "custom" };

  it("returns the leaf when it is already a message entry", () => {
    const entryId = resolveTerminalMessageEntryId({
      getLeafId: () => "leaf-1",
      getEntry: (id) =>
        id === "leaf-1" ? { id: "leaf-1", parentId: null, type: "message" } : undefined,
    });

    expect(entryId).toBe("leaf-1");
  });

  it("walks one cache-ttl marker down to its parent message", () => {
    const entryId = resolveTerminalMessageEntryId({
      getLeafId: () => "marker-1",
      getEntry: (id) => (id === marker.id ? marker : id === base.id ? base : undefined),
    });

    expect(entryId).toBe("assistant-1");
  });

  it("walks past stacked custom entries to the nearest message", () => {
    const entryId = resolveTerminalMessageEntryId({
      getLeafId: () => "snapshot-1",
      getEntry: (id) =>
        id === "snapshot-1"
          ? snapshot
          : id === "marker-1"
            ? marker
            : id === base.id
              ? base
              : undefined,
    });

    expect(entryId).toBe("assistant-1");
  });

  it("returns null when the leaf chain has no message below the custom entry", () => {
    const entryId = resolveTerminalMessageEntryId({
      getLeafId: () => "marker-1",
      getEntry: (id) =>
        id === "marker-1" ? { id: "marker-1", parentId: null, type: "custom" } : undefined,
    });

    expect(entryId).toBeNull();
  });

  it("returns null when there is no leaf", () => {
    const entryId = resolveTerminalMessageEntryId({
      getLeafId: () => null,
      getEntry: () => undefined,
    });

    expect(entryId).toBeNull();
  });

  it("cuts through a real cache-ttl marker on a SessionManager leaf", async () => {
    // Mirrors the durable-advancement turn shape from #156425: the transcript ends
    // message(assistant, stop) then custom(openclaw.cache-ttl). The helper is
    // resolved against a real SessionManager registry (getLeafId/getEntry).
    const { SessionManager } = await import("../../sessions/session-manager.js");
    const timestamp = new Date().toISOString();
    const sessionManager = SessionManager.fromEntries([
      {
        type: "session",
        version: 2,
        id: "anchor-156425",
        timestamp,
        cwd: process.cwd(),
      },
      {
        type: "message",
        id: "assistant-final",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: "answer",
          api: "messages",
          provider: "anthropic",
          model: "sonnet-4.6",
          stopReason: "stop",
          timestamp: Date.now(),
        },
      },
      {
        type: "custom",
        id: "cache-ttl-marker",
        parentId: "assistant-final",
        timestamp,
        customType: "openclaw.cache-ttl",
      },
    ]);

    const entryId = resolveTerminalMessageEntryId(sessionManager);

    expect(entryId).toBe("assistant-final");
  });
});
