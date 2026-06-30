// Agent-navigable tag graph: given one tag, return ranked co-occurring
// neighbor tags plus the shared target refs at each intersection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { associateMemoryTag, upsertMemoryTag } from "./associative-store.js";
import { readTagCooccurrence } from "./tag-graph.js";

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function tempScope() {
  return scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tag-graph-")));
}

function addTag(scope: ReturnType<typeof tempScope>, tagId: string, label: string): void {
  upsertMemoryTag({ ...scope, tag: { tagId, label } });
}

function tagTarget(
  scope: ReturnType<typeof tempScope>,
  tagId: string,
  target:
    | { boxId: string; type: "box" }
    | { spanId: string; type: "span" }
    | { seq: number; type: "turn" },
): void {
  associateMemoryTag({
    ...scope,
    source: "agent",
    tagId,
    target: { ...target, sessionKey: scope.sessionKey },
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("readTagCooccurrence", () => {
  it("ranks neighbor tags by shared targets and returns the intersections", () => {
    const s = tempScope();
    addTag(s, "tag-lisbon", "Lisbon");
    addTag(s, "tag-travel", "Travel");
    addTag(s, "tag-food", "Food");

    tagTarget(s, "tag-lisbon", { type: "turn", seq: 1 });
    tagTarget(s, "tag-travel", { type: "turn", seq: 1 });
    tagTarget(s, "tag-lisbon", { type: "box", boxId: "box-trip" });
    tagTarget(s, "tag-travel", { type: "box", boxId: "box-trip" });
    tagTarget(s, "tag-lisbon", { type: "span", spanId: "span-dinner" });
    tagTarget(s, "tag-food", { type: "span", spanId: "span-dinner" });

    expect(readTagCooccurrence({ ...s, tag: "lisbon" })).toEqual({
      tag: { tagId: "tag-lisbon", label: "Lisbon" },
      neighbors: [
        {
          tagId: "tag-travel",
          label: "Travel",
          weight: 2,
          targets: [
            { targetType: "box", targetId: "box-trip" },
            { targetType: "turn", targetId: "1" },
          ],
        },
        {
          tagId: "tag-food",
          label: "Food",
          weight: 1,
          targets: [{ targetType: "span", targetId: "span-dinner" }],
        },
      ],
    });
  });

  it("can resolve by tag id, limit results, and stays session-scoped", () => {
    const s = tempScope();
    addTag(s, "tag-memory", "Memory");
    addTag(s, "tag-ui", "UI");
    addTag(s, "tag-hidden", "Hidden");

    tagTarget(s, "tag-memory", { type: "turn", seq: 1 });
    tagTarget(s, "tag-ui", { type: "turn", seq: 1 });

    associateMemoryTag({
      ...s,
      source: "agent",
      tagId: "tag-hidden",
      target: { type: "turn", sessionKey: "agent:main:other", seq: 1 },
    });
    associateMemoryTag({
      ...s,
      source: "agent",
      tagId: "tag-memory",
      target: { type: "turn", sessionKey: "agent:main:other", seq: 1 },
    });

    expect(readTagCooccurrence({ ...s, tag: "tag-memory", limit: 1 }).neighbors).toEqual([
      {
        tagId: "tag-ui",
        label: "UI",
        weight: 1,
        targets: [{ targetType: "turn", targetId: "1" }],
      },
    ]);
  });

  it("returns an empty traversal for an unknown tag", () => {
    expect(readTagCooccurrence({ ...tempScope(), tag: "missing" })).toEqual({
      tag: null,
      neighbors: [],
    });
  });
});
