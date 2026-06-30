// 03-03 local entity producer: conservative lexical extraction, local-only entities,
// cross-span recall keys, deterministic ids, idempotent/no-churn on replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  associateConversationEntities,
  entityIdFor,
  extractEntities,
} from "./associate-entities.js";
import { listMemoryAssociations, listMemoryEntities } from "./associative-store.js";
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

/** NEBULA-73 recurs in two distinct (non-contiguous) topics; the [SILENT] turn is noise. */
function seedAndSegment(s: ReturnType<typeof scope>) {
  appendTurns({
    ...s,
    turns: [
      turn("k1", "Met with Acme Corp about the NEBULA-73 rollout"),
      turn("k2", "Follow up on NEBULA-73 invoice details"),
      turn("k3", "[SILENT] PING-9 heartbeat tick"),
    ],
  });
  return segmentConversationTurns(s);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("extractEntities", () => {
  it("extracts codes and multi-word proper nouns, skipping sentence-initial words", () => {
    expect(extractEntities("Met with Acme Corp about the NEBULA-73 rollout")).toEqual([
      { label: "Acme Corp", type: "proper_noun" },
      { label: "NEBULA-73", type: "code" },
    ]);
    // Lone sentence-initial / function words never anchor an entity.
    expect(extractEntities("Follow up on the invoice")).toEqual([]);
    expect(extractEntities("We Should Ship Memory soon")).toEqual([
      { label: "Ship Memory", type: "proper_noun" },
    ]);
    // Pure digits are not entities; a single capital is not a code.
    expect(extractEntities("It cost 73 dollars")).toEqual([]);
  });

  it("derives deterministic, type-scoped ids", () => {
    expect(entityIdFor("NEBULA-73", "code")).toBe(entityIdFor("nebula-73", "code"));
    expect(entityIdFor("NEBULA-73", "code")).not.toBe(entityIdFor("NEBULA-73", "proper_noun"));
    expect(entityIdFor("Acme Corp", "proper_noun")).toMatch(/^entity-[0-9a-f]{16}$/);
  });
});

describe("associateConversationEntities", () => {
  it("links recurring entities across non-contiguous spans, excluding noise", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associate-entities-")));
    const segmentation = seedAndSegment(s);
    const result = associateConversationEntities({ ...s, segmentation });

    // Acme Corp + NEBULA-73 only; PING-9 lives in the suppressed span and is skipped.
    expect(result.entities).toBe(2);
    const entities = listMemoryEntities(s);
    expect(entities.map((e) => e.label).toSorted()).toEqual(["Acme Corp", "NEBULA-73"]);
    expect(entities.every((e) => e.local_only === 1)).toBe(true);
    expect(entities.map((e) => e.entity_type).toSorted()).toEqual(["code", "proper_noun"]);

    // NEBULA-73 recurs in both topic spans → two span associations (cross-span recall).
    const nebula = entityIdFor("NEBULA-73", "code");
    const nebulaSpans = listMemoryAssociations(s).filter(
      (row) => row.entity_id === nebula && row.target_type === "span",
    );
    expect(nebulaSpans).toHaveLength(2);
    // No association ever points at PING-9.
    expect(listMemoryEntities(s).some((e) => e.label === "PING-9")).toBe(false);
  });

  it("is idempotent and does not bump entity updated_at on replay", () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associate-entities-")));
      const segmentation = seedAndSegment(s);
      associateConversationEntities({ ...s, segmentation });
      const before = listMemoryAssociations(s);
      const stamps = listMemoryEntities(s).map((e) => e.updated_at);
      expect(stamps.every((ts) => ts === t0)).toBe(true);

      vi.setSystemTime(t0 + 5_000);
      associateConversationEntities({ ...s, segmentation });

      expect(listMemoryAssociations(s)).toHaveLength(before.length);
      expect(listMemoryEntities(s).map((e) => e.updated_at)).toEqual(stamps);
    } finally {
      vi.useRealTimers();
    }
  });
});
