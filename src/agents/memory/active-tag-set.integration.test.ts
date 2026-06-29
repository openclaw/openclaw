// applyAutoCollapse (02-03): the I/O wrapper reads the per-agent store, runs the
// active-tag-set rule, and flips stale boxes to collapsed — leaving the active box and
// turns untouched. Proves the path the accordion context extension invokes each turn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { COLLAPSE_DWELL_TURNS } from "./accordion-constants.js";
import { applyAutoCollapse } from "./active-tag-set.js";
import { appendTurns, listBoxes, upsertBox, upsertSpan, type NewTurn } from "./turns-store.js";

const SCOPE = { agentId: "main", sessionKey: "agent:main:main" } as const;
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-accd-auto-"));
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("applyAutoCollapse", () => {
  it("collapses the stale topic box after a topic switch, keeping the active one live", () => {
    // 2 voice turns, then COLLAPSE_DWELL_TURNS+1 coding turns on distinct topics.
    const turns: NewTurn[] = [];
    let seq = 0;
    const push = (topic: string, boxId: string) => {
      seq += 1;
      turns.push({
        role: seq % 2 ? "user" : "assistant",
        content: `t${seq}`,
        contentHash: `h${seq}`,
        idempotencyKey: `k${seq}`,
        ts: seq,
      });
      upsertSpan({
        agentId: SCOPE.agentId,
        span: {
          spanId: `s${seq}`,
          sessionKey: SCOPE.sessionKey,
          startSeq: seq,
          endSeq: seq,
          topic,
          boxId,
        },
      });
    };
    push("voice", "box-voice");
    push("voice", "box-voice");
    for (let i = 0; i < COLLAPSE_DWELL_TURNS + 1; i += 1) {
      push(`code-${i}`, "box-code");
    }
    appendTurns({ ...SCOPE, turns });
    upsertBox({
      agentId: SCOPE.agentId,
      box: { boxId: "box-voice", sessionKey: SCOPE.sessionKey, state: "live" },
    });
    upsertBox({
      agentId: SCOPE.agentId,
      box: { boxId: "box-code", sessionKey: SCOPE.sessionKey, state: "live" },
    });

    const collapsed = applyAutoCollapse(SCOPE);
    expect(collapsed).toEqual(["box-voice"]);

    const byId = new Map(listBoxes(SCOPE).map((b) => [b.box_id, b.state]));
    expect(byId.get("box-voice")).toBe("collapsed");
    expect(byId.get("box-code")).toBe("live"); // active topic stays live
  });

  it("is a no-op when there are no live boxes", () => {
    upsertBox({
      agentId: SCOPE.agentId,
      box: { boxId: "box-1", sessionKey: SCOPE.sessionKey, state: "collapsed" },
    });
    expect(applyAutoCollapse(SCOPE)).toEqual([]);
  });
});
