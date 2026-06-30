// Tuning harness (04-04 Task 2): replay candidates over backfilled history, score against the
// resurfacing reference, rank recall-safety-first. Proves a candidate that collapses a box
// before its reappearance ranks worse, and the before/after evidence is aggregate numbers only
// (no transcript content — T-04D-01). Spans/boxes are seeded directly for a deterministic case;
// DB env is injected, runtime never booted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { CollapseParams } from "./active-tag-set.js";
import { runTuningHarness } from "./tuning-harness.js";
import { appendTurns, upsertBox, upsertSpan, type NewTurn } from "./turns-store.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";
const SECRET = "CLIENT-PRIVATE-CASEFILE";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tuning-harness-"));
}

function env(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

function turn(seq: number): NewTurn {
  // Content carries a secret marker so the test can assert it never leaks into the evidence.
  return {
    role: seq % 2 ? "user" : "assistant",
    content: `${SECRET} turn ${seq}`,
    contentHash: `h${seq}`,
    idempotencyKey: `k${seq}`,
    ts: seq,
  };
}

// box-alpha is active at 1-3, falls out while six distinct topics run at 4-9, then RESURFACES at
// seq 10. A rule that collapses box-alpha during 4-9 commits a recall failure; a conservative rule
// keeps it live past the reappearance.
function seedResurfacingCase(stateDir: string): void {
  const opts = { agentId: AGENT_ID, env: env(stateDir) };
  appendTurns({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    env: env(stateDir),
    turns: Array.from({ length: 10 }, (_, i) => turn(i + 1)),
  });
  const span = (boxId: string, topic: string, startSeq: number, endSeq: number): void => {
    upsertBox({ ...opts, box: { boxId, sessionKey: SESSION_KEY, label: topic, state: "live" } });
    upsertSpan({
      ...opts,
      span: {
        spanId: `sp-${boxId}-${startSeq}`,
        sessionKey: SESSION_KEY,
        startSeq,
        endSeq,
        topic,
        boxId,
      },
    });
  };
  span("box-alpha", "alpha", 1, 3);
  const fillers = ["b", "c", "d", "e", "f", "g"];
  fillers.forEach((topic, i) => span(`box-${topic}`, topic, 4 + i, 4 + i));
  span("box-alpha", "alpha", 10, 10); // resurfaces after the gap
}

const AGGRESSIVE: CollapseParams = {
  mode: "jaccard-distance",
  activeWindowTurns: 6,
  jaccardLiveCutoff: 0.3,
  collapseDwellTurns: 1,
  activeSetCardinalityFloor: 1,
};
const CONSERVATIVE: CollapseParams = {
  mode: "zero-intersection",
  activeWindowTurns: 6,
  zeroIntersectionDwellTurns: 100, // dwell longer than the whole fixture → never collapses here
  activeSetCardinalityFloor: 2,
};

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("runTuningHarness", () => {
  it("ranks the recall-failing candidate worse and surfaces the disagreement", () => {
    const stateDir = tempStateDir();
    seedResurfacingCase(stateDir);

    const result = runTuningHarness({
      agentId: AGENT_ID,
      env: env(stateDir),
      candidates: [
        { name: "aggressive", params: AGGRESSIVE },
        { name: "conservative", params: CONSERVATIVE },
      ],
    });

    // Both candidates were scored.
    expect(result.ranked.map((c) => c.name).toSorted()).toEqual(["aggressive", "conservative"]);

    const aggressive = result.ranked.find((c) => c.name === "aggressive")!;
    const conservative = result.ranked.find((c) => c.name === "conservative")!;
    expect(aggressive.score.recallFailures).toBeGreaterThanOrEqual(1); // collapsed box-alpha before seq 10
    expect(conservative.score.recallFailures).toBe(0);

    // Recall safety dominates: the conservative rule wins despite collapsing nothing (zero savings).
    expect(result.winner.name).toBe("conservative");
    expect(conservative.score.value).toBeGreaterThan(aggressive.score.value);

    // The decisive disagreement on box-alpha is surfaced for the operator-confirm step.
    expect(result.disagreements.some((d) => d.boxId === "box-alpha")).toBe(true);
  });

  it("emits aggregate-only evidence with no transcript content", () => {
    const stateDir = tempStateDir();
    seedResurfacingCase(stateDir);

    const result = runTuningHarness({
      agentId: AGENT_ID,
      env: env(stateDir),
      candidates: [
        { name: "aggressive", params: AGGRESSIVE },
        { name: "conservative", params: CONSERVATIVE },
      ],
    });

    expect(result.evidence.candidates).toHaveLength(2);
    expect(result.evidence.winner.name).toBe("conservative");
    expect(typeof result.evidence.winner.savingsPct).toBe("number");
    // No raw transcript content may appear anywhere in the PR-bound evidence block.
    expect(JSON.stringify(result.evidence)).not.toContain(SECRET);
  });
});
