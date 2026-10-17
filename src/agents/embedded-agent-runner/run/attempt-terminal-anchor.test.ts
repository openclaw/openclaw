import { describe, expect, it } from "vitest";
import { SessionManager } from "../../sessions/session-manager.js";
import { resolveTerminalMessageEntryId } from "./attempt-terminal-anchor.js";

type FakeEntry = { id: string; parentId: string | null; type: string; customType?: string };

function managerFor(entries: FakeEntry[], leafId: string | null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getEntry: (id: string) => byId.get(id),
  };
}

describe("resolveTerminalMessageEntryId", () => {
  const base = { id: "assistant-1", parentId: null, type: "message" };
  const marker = {
    id: "marker-1",
    parentId: "assistant-1",
    type: "custom",
    customType: "openclaw.cache-ttl",
  };
  const snapshot = {
    id: "snapshot-1",
    parentId: "marker-1",
    type: "custom",
    customType: "projection-snapshot",
  };

  const secondMarker = { ...marker, id: "marker-2", parentId: marker.id };
  const trailingMarker = { ...marker, id: "trailing", parentId: snapshot.id };
  it.each<[string, FakeEntry[], string | null, string | null]>([
    ["message leaf", [base], base.id, base.id],
    ["stacked markers", [base, marker, secondMarker], secondMarker.id, base.id],
    ["custom leaf", [base, marker, snapshot], snapshot.id, snapshot.id],
    [
      "marker after custom leaf",
      [base, marker, snapshot, trailingMarker],
      trailingMarker.id,
      snapshot.id,
    ],
    ["parentless marker", [{ ...marker, parentId: null }], marker.id, null],
    ["missing parent", [marker], marker.id, null],
    ["no leaf", [], null, null],
  ])("resolves %s", (_name, entries, leaf, expected) => {
    expect(resolveTerminalMessageEntryId(managerFor(entries, leaf))).toBe(expected);
  });

  it("cuts through a real cache-ttl marker on a SessionManager leaf", () => {
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
