// 03-04 read-only associative context facade: the compact box+tags+entities view the
// memory-core seam consumes. Built end-to-end from the segmentation/tag/entity producers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { associateConversationEntities } from "./associate-entities.js";
import { associateSegmentationTopics } from "./associate-topics.js";
import { readAssociativeContext } from "./associative-context.js";
import { segmentConversationTurns } from "./segment-spans.js";
import { appendTurns, type NewTurn } from "./turns-store.js";

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(idempotencyKey: string, content: string): NewTurn {
  return { role: "user", content, contentHash: `hash-${idempotencyKey}`, idempotencyKey, ts: 1 };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("readAssociativeContext", () => {
  it("returns a fresh empty result each call, so mutating one does not leak into the next", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assoc-context-")));
    const first = readAssociativeContext(s);
    expect(first).toEqual({ boxes: [] });
    // Public read surface: a caller mutating the array must not affect a later empty read.
    first.boxes.push({
      boxId: "x",
      topic: "x",
      summary: null,
      state: "live",
      tags: [],
      entities: [],
    });
    expect(readAssociativeContext(s)).toEqual({ boxes: [] });
  });

  it("returns each box with its summary, tags, and entities", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assoc-context-")));
    appendTurns({ ...s, turns: [turn("k1", "Met with Acme Corp about the NEBULA-73 rollout")] });
    const segmentation = segmentConversationTurns(s);
    associateSegmentationTopics({ ...s, segmentation });
    associateConversationEntities({ ...s, segmentation });

    const context = readAssociativeContext(s);
    expect(context.boxes).toHaveLength(1);
    const box = context.boxes[0];
    expect(box.topic).toBe("met");
    expect(box.state).toBe("live");
    expect(box.summary && box.summary.length > 0).toBe(true);
    expect(box.tags).toEqual(["met"]);
    expect(box.entities).toEqual(["Acme Corp", "NEBULA-73"]);
  });
});
