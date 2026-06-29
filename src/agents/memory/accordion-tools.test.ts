// Accordion tools (02-03): expand_topic/collapse_topic flip boxes.state via the manual
// override path. Seed a box + a turn, run the tool, assert the state flip, label/id
// resolution, the head-bump on manual expand, and the no-match error result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createAccordionTools } from "./accordion-tools.js";
import { appendTurns, listBoxes, upsertBox } from "./turns-store.js";

const SCOPE = { agentId: "main", sessionKey: "agent:main:main" } as const;
let priorStateDir: string | undefined;

function tool(name: "expand_topic" | "collapse_topic") {
  const t = createAccordionTools(SCOPE).find((x) => x.name === name);
  if (!t) {
    throw new Error(`missing tool ${name}`);
  }
  return t;
}

async function run(name: "expand_topic" | "collapse_topic", topic: string) {
  const result = await tool(name).execute("call-1", { topic }, new AbortController().signal);
  return JSON.parse((result.content[0] as { text: string }).text) as {
    ok: boolean;
    boxId?: string;
    state?: string;
    error?: string;
  };
}

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-accd-tool-"));
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("accordion tools", () => {
  function seed(state: "live" | "collapsed") {
    upsertBox({
      agentId: SCOPE.agentId,
      box: { boxId: "box-voice", sessionKey: SCOPE.sessionKey, label: "Voice", state },
    });
  }

  it("collapse_topic flips a live box to collapsed (resolved by label)", async () => {
    seed("live");
    const res = await run("collapse_topic", "voice"); // case-insensitive label match
    expect(res).toMatchObject({ ok: true, boxId: "box-voice", state: "collapsed" });
    expect(listBoxes(SCOPE).find((b) => b.box_id === "box-voice")?.state).toBe("collapsed");
  });

  it("expand_topic flips a collapsed box live and bumps last_active_seq to the head", async () => {
    seed("collapsed");
    appendTurns({
      ...SCOPE,
      turns: [
        { role: "user", content: "a", contentHash: "h1", idempotencyKey: "k1", ts: 1 },
        { role: "assistant", content: "b", contentHash: "h2", idempotencyKey: "k2", ts: 2 },
      ],
    }); // seq 1,2 → head = 2
    const res = await run("expand_topic", "box-voice"); // resolve by id
    expect(res).toMatchObject({ ok: true, state: "live" });
    const box = listBoxes(SCOPE).find((b) => b.box_id === "box-voice");
    expect(box?.state).toBe("live");
    expect(box?.last_active_seq).toBe(2); // override head bump → auto-collapse dwell protected
  });

  it("returns ok:false with an error when no topic box matches", async () => {
    seed("live");
    const res = await run("expand_topic", "nonexistent");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nonexistent");
  });
});
