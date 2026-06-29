import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { COLLAPSE_DWELL_TURNS } from "./accordion-constants.js";
import { applyAutoCollapse } from "./active-tag-set.js";
import { segmentConversationTurns, segmentTurns } from "./segment-spans.js";
import { appendTurns, listBoxes, listSpans, setBoxState, type NewTurn } from "./turns-store.js";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-segment-spans-"));
}

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(seq: number, content: string, overrides: Partial<NewTurn> = {}): NewTurn {
  return {
    role: seq % 2 ? "user" : "assistant",
    content,
    contentHash: `h${seq}`,
    idempotencyKey: `k${seq}`,
    ts: seq,
    ...overrides,
  };
}

function persistedTurn(seq: number, content: string, overrides: Partial<NewTurn> = {}) {
  return {
    seq,
    session_key: "agent:main:main",
    content,
    channel: overrides.channel ?? null,
    noise_class: overrides.noiseClass ?? null,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("segmentTurns", () => {
  it("splits topic spans and groups non-contiguous same-topic spans into one box", () => {
    const result = segmentTurns([
      persistedTurn(1, "voice microphone setup"),
      persistedTurn(2, "repo branch implementation"),
      persistedTurn(3, "voice audio settings"),
    ]);

    expect(result.spans.map((span) => span.topic)).toEqual(["voice", "repo", "voice"]);
    expect(result.boxes.map((box) => box.label).toSorted()).toEqual(["repo", "voice"]);
    const voiceBoxIds = result.spans
      .filter((span) => span.topic === "voice")
      .map((span) => span.boxId);
    expect(new Set(voiceBoxIds).size).toBe(1);
  });

  it("marks silent and heartbeat spans as suppressed noise", () => {
    const result = segmentTurns([
      persistedTurn(1, "[SILENT] heartbeat"),
      persistedTurn(2, "timer tick", { channel: "heartbeat" }),
      persistedTurn(3, "voice microphone setup"),
    ]);

    expect(result.spans[0]).toMatchObject({
      topic: null,
      boxId: null,
      noiseClass: "suppressed",
    });
    expect(result.spans[1]).toMatchObject({
      topic: "voice",
      noiseClass: null,
    });
  });

  it("produces deterministic ids and summaries", () => {
    const turns = [
      persistedTurn(1, "voice microphone setup"),
      persistedTurn(2, "repo branch implementation"),
    ];
    expect(segmentTurns(turns)).toEqual(segmentTurns(turns));
    expect(segmentTurns(turns).boxes[0]?.summary).toBe("voice: voice microphone setup (1 turn)");
  });
});

describe("segmentConversationTurns", () => {
  it("upserts spans and boxes idempotently without changing collapsed box state", () => {
    const s = scope(tempStateDir());
    appendTurns({
      ...s,
      turns: [
        turn(1, "voice microphone setup"),
        turn(2, "repo branch implementation"),
        turn(3, "voice audio settings"),
      ],
    });

    segmentConversationTurns(s);
    const firstSpans = listSpans(s);
    const firstBoxes = listBoxes(s);
    const voiceBox = firstBoxes.find((box) => box.label === "voice");
    expect(voiceBox).toBeTruthy();
    setBoxState({ ...s, boxId: voiceBox?.box_id ?? "", state: "collapsed" });

    segmentConversationTurns(s);
    expect(listSpans(s).map((span) => span.span_id)).toEqual(
      firstSpans.map((span) => span.span_id),
    );
    expect(listBoxes(s).length).toBe(firstBoxes.length);
    expect(listBoxes(s).find((box) => box.box_id === voiceBox?.box_id)?.state).toBe("collapsed");
  });

  it("produces spans and boxes that drive the existing auto-collapse rule", () => {
    const s = scope(tempStateDir());
    const turns: NewTurn[] = [turn(1, "voice microphone setup"), turn(2, "voice audio settings")];
    const activeTopics = ["repo", "tests", "build", "types", "lint", "review", "commit"];
    for (let index = 0; index < COLLAPSE_DWELL_TURNS + 1; index += 1) {
      turns.push(turn(index + 3, `${activeTopics[index]} ${activeTopics[index]} task`));
    }
    appendTurns({ ...s, turns });
    segmentConversationTurns(s);

    const collapsed = applyAutoCollapse(s);
    const voiceBox = listBoxes(s).find((box) => box.label === "voice");
    expect(collapsed).toEqual([voiceBox?.box_id]);
    expect(voiceBox).toBeTruthy();
    expect(listBoxes(s).find((box) => box.box_id === voiceBox?.box_id)?.state).toBe("collapsed");
  });
});
