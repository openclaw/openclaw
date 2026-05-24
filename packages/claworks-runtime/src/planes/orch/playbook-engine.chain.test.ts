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

describe("dispatch_mes_on_workorder_created", () => {
  it("executes mes_production_dispatch action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-chain-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const dispatchDef: PlaybookDefinition = {
      id: "dispatch_mes_on_workorder_created",
      name: "MES",
      pack: "test",
      trigger: {
        kind: "event",
        pattern: "workorder.created",
        condition: "bool(payload.get('source_alarm_id')) and bool(payload.get('workorder_id'))",
      },
      priority: 5,
      steps: [
        {
          kind: "action",
          id: "dispatch_mes",
          actionApiName: "mes_production_dispatch",
          params: {
            station_id: "S1",
            workorder_id: "{{ payload.get('workorder_id', '') }}",
          },
          onFailure: "continue",
        },
      ],
    };

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

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: [dispatchDef.id], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [dispatchDef],
      },
    ]);

    const run = await engine.trigger("dispatch_mes_on_workorder_created", {
      source_alarm_id: "al-chain",
      workorder_id: "wo-chain",
      station_id: "S1",
    });
    expect(run.status).toBe("completed");
    expect(run.steps[0]?.output).toMatchObject({ status: "ok", mode: "simulate" });

    close();
  });
});

describe("call_playbook nested session_id", () => {
  it("inherits parent session_id for assistant turn recording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-nested-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const append = vi.fn();
    const contextEngine = { append, getRecent: vi.fn().mockReturnValue([]) };

    const childDef: PlaybookDefinition = {
      id: "child_reply",
      name: "Child",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "llm",
          id: "reply",
          prompt: "say nested",
          output: "reply",
        },
      ],
    };

    const parentDef: PlaybookDefinition = {
      id: "parent_call",
      name: "Parent",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "call_playbook",
          id: "call_child",
          playbookId: "child_reply",
        },
      ],
    };

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
      llmComplete: vi.fn().mockResolvedValue({ text: "nested reply" }),
    });

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: {
            objectTypes: [],
            playbooks: ["parent_call", "child_reply"],
            actionTypes: [],
          },
        },
        path: dir,
        objectTypes: [],
        playbooks: [parentDef, childDef],
      },
    ]);

    const run = await engine.trigger("parent_call", { session_id: "sess-nested-1" });
    expect(run.status).toBe("completed");
    expect(append).toHaveBeenCalledWith("sess-nested-1", "assistant", "nested reply", {
      playbook_id: "child_reply",
      run_id: expect.any(String),
    });

    close();
  });
});
