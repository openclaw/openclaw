import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";
import type { PlaybookDefinition } from "./playbook-types.js";

describe("playbook-engine action/function steps", () => {
  it("runs ingest_kb_text action step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-action-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const kb = createKnowledgeBase();

    const engine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb,
      robot: {
        name: "t",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
    });

    const def: PlaybookDefinition = {
      id: "ingest_flow",
      name: "Ingest",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "ingest",
          actionApiName: "ingest_kb_text",
          params: { text: "sensor manual excerpt", title: "manual-1" },
          output: "ingest",
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
          provides: { objectTypes: [], playbooks: ["ingest_flow"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run = await engine.trigger("ingest_flow", {});
    expect(run.status).toBe("completed");
    const hits = await kb.search("sensor manual", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);

    close();
  });

  it("runs DiagnoseEquipment function without LLM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-fn-"));
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
      id: "diag_flow",
      name: "Diag",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "function",
          id: "diag",
          functionApiName: "DiagnoseEquipment",
          params: { equipment_id: "pump-42", symptoms: ["vibration"] },
          output: "diag",
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
          provides: { objectTypes: [], playbooks: ["diag_flow"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run = await engine.trigger("diag_flow", {});
    expect(run.status).toBe("completed");
    const step = run.steps.find((s) => s.stepId === "diag");
    expect(step?.output).toMatchObject({
      status: "ok",
      summary: expect.stringContaining("pump-42"),
    });

    close();
  });

  it("runs reload_packs action when reloadPacks hook provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-reload-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    let reloadCalls = 0;

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
      reloadPacks: async () => {
        reloadCalls += 1;
        return {
          packs: [{ manifest: { id: "demo-pack" } }],
        };
      },
    });

    const def: PlaybookDefinition = {
      id: "reload_flow",
      name: "Reload",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "reload",
          actionApiName: "reload_packs",
          params: {},
          output: "reload",
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
          provides: { objectTypes: [], playbooks: ["reload_flow"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run = await engine.trigger("reload_flow", {});
    expect(run.status).toBe("completed");
    expect(reloadCalls).toBe(1);
    expect(run.steps[0]?.output).toMatchObject({
      status: "ok",
      total: 1,
      pack_ids: ["demo-pack"],
    });

    close();
  });
});
