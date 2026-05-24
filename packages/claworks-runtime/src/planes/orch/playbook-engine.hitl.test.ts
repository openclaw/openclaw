import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";
import type { PlaybookDefinition } from "./playbook-types.js";

describe("playbook-engine HITL resume", () => {
  it("suspends on hitl and continues after decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-hitl-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const engine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: {
        name: "t",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
    });

    const def: PlaybookDefinition = {
      id: "hitl_flow",
      name: "HITL test",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "hitl",
          id: "approve",
          message: "Approve?",
          options: ["approve", "reject"],
          output: "decision",
        },
        {
          kind: "notification",
          id: "done",
          message: "Decision: {{ hitl_decision }}",
        },
      ],
    };

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["hitl_flow"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run1 = await engine.trigger("hitl_flow", {});
    expect(run1.status).toBe("waiting_hitl");

    const run2 = await engine.submitHitlDecision(run1.id, "approve", "approve", "ok");
    expect(run2.status).toBe("completed");
    expect(run2.steps).toHaveLength(2);
    expect(run2.steps[1]?.output).toMatchObject({
      message: expect.stringContaining("approve"),
    });

    close();
  });

  it("records assistant turn after HITL resume when session_id and reply are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-hitl-ctx-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const append = vi.fn();
    const contextEngine = { append, getRecent: vi.fn().mockReturnValue([]) };

    const engine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: {
        name: "t",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
      contextEngine,
      llmComplete: vi.fn().mockResolvedValue({ text: "approved and done" }),
    });

    const def: PlaybookDefinition = {
      id: "hitl_reply",
      name: "HITL reply",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "hitl",
          id: "approve",
          message: "Approve?",
          options: ["approve"],
          output: "decision",
        },
        {
          kind: "llm",
          id: "reply_step",
          prompt: "say done",
          output: "reply",
        },
      ],
    };

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["hitl_reply"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run1 = await engine.trigger("hitl_reply", { session_id: "sess-hitl-1" });
    expect(run1.status).toBe("waiting_hitl");
    expect(append).not.toHaveBeenCalled();

    const run2 = await engine.submitHitlDecision(run1.id, "approve", "approve");
    expect(run2.status).toBe("completed");
    expect(append).toHaveBeenCalledWith("sess-hitl-1", "assistant", "approved and done", {
      playbook_id: "hitl_reply",
      run_id: run1.id,
    });

    close();
  });
});
