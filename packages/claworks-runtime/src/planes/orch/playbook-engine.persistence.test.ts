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

function makeEngine(dbPath: string) {
  const { db, close } = openDatabase(`sqlite://${dbPath}`);
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
  return { engine, close };
}

const hitlDef: PlaybookDefinition = {
  id: "hitl_persist",
  name: "HITL persist",
  pack: "test",
  trigger: { kind: "manual" },
  priority: 0,
  steps: [
    {
      kind: "hitl",
      id: "approve",
      message: "Approve?",
      options: ["approve", "reject"],
    },
    { kind: "notification", id: "done", message: "ok" },
  ],
};

describe("playbook-engine persistence", () => {
  it("listRuns merges memory and database rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-list-"));
    const dbPath = join(dir, "t.db");
    const { engine, close } = makeEngine(dbPath);

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["a", "b"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [
          {
            id: "a",
            name: "A",
            pack: "test",
            trigger: { kind: "manual" },
            priority: 0,
            steps: [{ kind: "notification", id: "n", message: "a" }],
          },
          {
            id: "b",
            name: "B",
            pack: "test",
            trigger: { kind: "manual" },
            priority: 0,
            steps: [{ kind: "notification", id: "n", message: "b" }],
          },
        ],
      },
    ]);

    await engine.trigger("a", {});
    await engine.trigger("b", {});

    const listed = await engine.listRuns({ limit: 10 });
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(listed.map((r) => r.playbookId));
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);

    close();
  });

  it("hydrates waiting_hitl after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-hydrate-"));
    const dbPath = join(dir, "t.db");

    let runId = "";
    {
      const { engine, close } = makeEngine(dbPath);
      await engine.loadFromPacks([
        {
          manifest: {
            id: "test",
            name: "t",
            version: "1",
            license: "MIT",
            provides: { objectTypes: [], playbooks: ["hitl_persist"], actionTypes: [] },
          },
          path: dir,
          objectTypes: [],
          playbooks: [hitlDef],
        },
      ]);
      const run = await engine.trigger("hitl_persist", {});
      expect(run.status).toBe("waiting_hitl");
      runId = run.id;
      close();
    }

    {
      const { engine, close } = makeEngine(dbPath);
      await engine.loadFromPacks([
        {
          manifest: {
            id: "test",
            name: "t",
            version: "1",
            license: "MIT",
            provides: { objectTypes: [], playbooks: ["hitl_persist"], actionTypes: [] },
          },
          path: dir,
          objectTypes: [],
          playbooks: [hitlDef],
        },
      ]);
      const hydrated = await engine.hydrateSuspendedRuns();
      expect(hydrated).toBe(1);
      const resumed = await engine.submitHitlDecision(runId, "approve", "approve");
      expect(resumed.status).toBe("completed");
      close();
    }
  });

  it("writes run.output on completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-output-"));
    const { engine, close } = makeEngine(join(dir, "t.db"));
    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["out"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [
          {
            id: "out",
            name: "Out",
            pack: "test",
            trigger: { kind: "manual" },
            priority: 0,
            steps: [
              {
                kind: "function",
                id: "set",
                functionApiName: "noop",
                params: { marker: "done" },
                output: "marker",
              },
            ],
          },
        ],
      },
    ]);
    const run = await engine.trigger("out", { seed: 1 });
    expect(run.status).toBe("completed");
    expect(run.output).toBeDefined();
    expect(run.output?.seed).toBe(1);
    close();
  });
});
