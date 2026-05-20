import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlaybookYaml } from "../../pack-loader/index.js";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";

const PACKS_ROOT = join(process.cwd(), "..", "claworks-packs");
const DIAGNOSE_YAML = join(
  PACKS_ROOT,
  "process-industry/ontology/playbooks/diagnose_on_alarm.yaml",
);

describe("pack YAML integration", () => {
  it.skipIf(!existsSync(DIAGNOSE_YAML))(
    "runs diagnose_on_alarm from claworks-packs through HITL",
    async () => {
      const content = await readFile(DIAGNOSE_YAML, "utf8");
      const def = parsePlaybookYaml(content, "process-industry");

      const dir = mkdtempSync(join(tmpdir(), "cw-pack-yaml-"));
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

      await engine.loadFromPacks([
        {
          manifest: {
            id: "process-industry",
            name: "pi",
            version: "1",
            license: "MIT",
            provides: { objectTypes: [], playbooks: [def.id], actionTypes: [] },
          },
          path: dir,
          objectTypes: [],
          playbooks: [def],
        },
      ]);

      const run1 = await engine.trigger("diagnose_on_alarm", {
        priority: "P1",
        alarm_id: "al-pack-1",
        equipment_id: "pump-pack",
        reading_values: { temp: 88 },
      });
      expect(run1.status).toBe("waiting_hitl");

      const run2 = await engine.submitHitlDecision(run1.id, "create_wo", "approve");
      expect(run2.status).toBe("completed");

      const { items: orders } = await createObjectStore(db).query("WorkOrder", { limit: 5 });
      expect(orders.length).toBeGreaterThan(0);

      close();
    },
  );
});
