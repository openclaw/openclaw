// readAccordionView (02-03-5): projects the durable boxes/spans into the UI-facing
// shape surfaced through chat.startup / chat.history. Proves state + span ranges round
// out and an empty session yields empty arrays (never throws).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { readAccordionView } from "./accordion-ui.js";
import { appendTurns, upsertBox, upsertSpan } from "./turns-store.js";

const SCOPE = { agentId: "main", sessionKey: "agent:main:main" } as const;
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-accd-ui-"));
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("readAccordionView", () => {
  it("returns empty boxes/spans for a session with no captured turns", () => {
    expect(readAccordionView(SCOPE)).toEqual({ boxes: [], spans: [] });
  });

  it("projects boxes (with state) and span seq-ranges into the UI shape", () => {
    appendTurns({
      ...SCOPE,
      turns: [
        { role: "user", content: "a", contentHash: "ha", idempotencyKey: "k1", ts: 1 },
        { role: "assistant", content: "b", contentHash: "hb", idempotencyKey: "k2", ts: 2 },
      ],
    });
    upsertBox({
      agentId: SCOPE.agentId,
      box: {
        boxId: "box-live",
        sessionKey: SCOPE.sessionKey,
        label: "Voice",
        state: "live",
        summary: null,
      },
    });
    upsertBox({
      agentId: SCOPE.agentId,
      box: {
        boxId: "box-folded",
        sessionKey: SCOPE.sessionKey,
        label: "Coding",
        state: "collapsed",
        summary: "Refactored the loader",
      },
    });
    upsertSpan({
      agentId: SCOPE.agentId,
      span: {
        spanId: "s1",
        sessionKey: SCOPE.sessionKey,
        startSeq: 1,
        endSeq: 1,
        topic: "voice",
        boxId: "box-live",
      },
    });
    upsertSpan({
      agentId: SCOPE.agentId,
      span: {
        spanId: "s2",
        sessionKey: SCOPE.sessionKey,
        startSeq: 2,
        endSeq: 2,
        topic: "coding",
        boxId: "box-folded",
      },
    });

    const view = readAccordionView(SCOPE);

    expect(view.boxes).toContainEqual({
      id: "box-live",
      label: "Voice",
      state: "live",
      summary: null,
    });
    expect(view.boxes).toContainEqual({
      id: "box-folded",
      label: "Coding",
      state: "collapsed",
      summary: "Refactored the loader",
    });
    expect(view.spans).toEqual([
      { boxId: "box-live", startSeq: 1, endSeq: 1, topic: "voice" },
      { boxId: "box-folded", startSeq: 2, endSeq: 2, topic: "coding" },
    ]);
  });
});
