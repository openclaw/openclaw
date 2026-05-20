import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlaybookStepContext } from "../orch/playbook-types.js";
import { openDatabase } from "./db.js";
import { createKnowledgeBase } from "./knowledge-base.js";
import { createObjectStore } from "./object-store.js";

describe("object-store events", () => {
  it("publishes workorder.created when creating WorkOrder with ctx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-wo-ev-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const store = createObjectStore(db);
    const ctx: PlaybookStepContext = {
      runId: "r1",
      playbookId: "test",
      variables: {},
      objectStore: store,
      kb: createKnowledgeBase(),
      robot: {
        name: "t",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      publishEvent: async (type, _source, payload) => {
        events.push({ type, payload });
      },
    };

    const wo = await ctx.objectStore.create(
      "WorkOrder",
      {
        equipment_id: "pump-1",
        source_alarm_id: "al-9",
        description: "test",
      },
      ctx,
    );
    expect(wo.id).toBeTruthy();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("workorder.created");
    expect(events[0]?.payload.workorder_id).toBe(wo.id);
    expect(events[0]?.payload.source_alarm_id).toBe("al-9");

    const mes = await ctx.objectStore.executeAction(
      "_mes",
      "_virtual",
      "mes_production_dispatch",
      { station_id: "S1", workorder_id: wo.id },
      ctx,
    );
    expect(mes.status).toBe("ok");
    expect(mes.mode).toBe("simulate");

    close();
  });
});
