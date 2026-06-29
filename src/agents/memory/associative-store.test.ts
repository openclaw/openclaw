// Phase 3 associative-memory foundation tests: local tags/entities plus links
// from durable turns/boxes to those concepts without changing retrieval yet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  associateMemoryEntity,
  associateMemoryTag,
  linkMemoryTagParent,
  listMemoryAssociations,
  listMemoryEntities,
  listMemoryTagEdges,
  listMemoryTags,
  upsertMemoryEntity,
  upsertMemoryTag,
} from "./associative-store.js";
import { appendTurns, upsertBox, type NewTurn } from "./turns-store.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associative-store-"));
}

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(idempotencyKey: string, content: string): NewTurn {
  return {
    role: "user",
    content,
    contentHash: `hash-${idempotencyKey}`,
    idempotencyKey,
    ts: 1_700_000_000_000,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("associative-store", () => {
  it("stores normalized local-only entities", () => {
    const s = scope(createTempStateDir());

    upsertMemoryEntity({
      ...s,
      entity: { entityId: "entity-aaron", type: "person", label: "  Aaron   Whaley  " },
    });

    const entities = listMemoryEntities(s);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      entity_id: "entity-aaron",
      entity_type: "person",
      label: "Aaron   Whaley",
      normalized_label: "aaron whaley",
      local_only: 1,
    });
  });

  it("supports multi-parent tag edges and rejects cycles", () => {
    const s = scope(createTempStateDir());
    upsertMemoryTag({ ...s, tag: { tagId: "tag-memory", label: "Memory" } });
    upsertMemoryTag({ ...s, tag: { tagId: "tag-ui", label: "Control UI" } });
    upsertMemoryTag({ ...s, tag: { tagId: "tag-agent-space", label: "Agent Space" } });

    linkMemoryTagParent({ ...s, childTagId: "tag-memory", parentTagId: "tag-ui" });
    linkMemoryTagParent({ ...s, childTagId: "tag-memory", parentTagId: "tag-agent-space" });

    expect(listMemoryTags(s).map((tag) => tag.tag_id)).toEqual([
      "tag-agent-space",
      "tag-ui",
      "tag-memory",
    ]);
    expect(listMemoryTagEdges(s).map((edge) => [edge.child_tag_id, edge.parent_tag_id])).toEqual([
      ["tag-memory", "tag-agent-space"],
      ["tag-memory", "tag-ui"],
    ]);
    expect(() =>
      linkMemoryTagParent({ ...s, childTagId: "tag-agent-space", parentTagId: "tag-memory" }),
    ).toThrow(/cycle/);
  });

  it("associates tags and entities to durable turns and boxes", () => {
    const s = scope(createTempStateDir());
    appendTurns({ ...s, turns: [turn("k1", "We should keep Agent Space generic first.")] });
    upsertBox({
      ...s,
      box: { boxId: "box-agent-space", sessionKey: s.sessionKey, label: "Agent Space" },
    });
    upsertMemoryTag({ ...s, tag: { tagId: "tag-strategy", label: "Strategy" } });
    upsertMemoryEntity({
      ...s,
      entity: { entityId: "entity-agent-space", type: "project", label: "Agent Space" },
    });

    associateMemoryTag({
      ...s,
      tagId: "tag-strategy",
      target: { type: "turn", sessionKey: s.sessionKey, seq: 1 },
      source: "agent",
      salience: 0.7,
    });
    associateMemoryEntity({
      ...s,
      entityId: "entity-agent-space",
      target: { type: "box", sessionKey: s.sessionKey, boxId: "box-agent-space" },
      source: "human",
    });

    expect(
      listMemoryAssociations(s)
        .map((row) => row.target_type)
        .toSorted(),
    ).toEqual(["box", "turn"]);
    expect(
      listMemoryAssociations({
        ...s,
        sessionKey: s.sessionKey,
        target: { type: "turn", sessionKey: s.sessionKey, seq: 1 },
      }),
    ).toEqual([
      expect.objectContaining({
        tag_id: "tag-strategy",
        entity_id: null,
        salience: 0.7,
        source: "agent",
      }),
    ]);
  });
});
