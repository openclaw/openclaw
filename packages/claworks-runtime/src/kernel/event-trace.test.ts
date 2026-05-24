import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../planes/data/db.js";
import { createKnowledgeBase } from "../planes/data/knowledge-base.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createHitlGate } from "../planes/orch/hitl-gate.js";
import { createPlaybookEngine } from "../planes/orch/playbook-engine.js";
import { createEventKernel } from "./event-kernel.js";
import { createRootTraceContext, formatTraceparent, parseTraceparent } from "./trace-context.js";
import type { CwEvent } from "./types.js";

function makePlaybookEngine() {
  const dir = mkdtempSync(join(tmpdir(), "cw-trace-"));
  const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
  const engine = createPlaybookEngine({
    db,
    objectStore: createObjectStore(db),
    kb: createKnowledgeBase(),
    robot: {
      name: "trace-bot",
      role: "monolith",
      version: "0",
      endpoint: "http://127.0.0.1:18800",
    },
    hitl: createHitlGate(),
    notify: async () => {},
  });
  return { engine, close };
}

describe("trace propagation EventKernel → PlaybookRun → StepLog", () => {
  it("EventKernel.publish assigns traceId from W3C traceparent", async () => {
    const { engine, close } = makePlaybookEngine();
    let seen: CwEvent | undefined;
    const parent = formatTraceparent(createRootTraceContext())!;
    const kernel = createEventKernel({
      playbookEngine: engine,
      onEventPublished: (event) => {
        seen = event;
      },
    });
    await kernel.start();
    await kernel.publish("probe.event", "test", { ok: true }, { traceparent: parent });
    close();

    expect(seen?.traceId).toBe(parseTraceparent(parent)?.traceId);
    expect(parseTraceparent(seen?.traceparent ?? "")?.traceId).toBe(
      parseTraceparent(parent)?.traceId,
    );
  });

  it("PlaybookRun and StepLog inherit traceparent from triggerEvent", async () => {
    const { engine, close } = makePlaybookEngine();
    engine.load({
      id: "trace_probe",
      name: "Trace Probe",
      pack: "base",
      priority: 1,
      trigger: { kind: "manual" },
      steps: [{ kind: "notification", id: "notify", message: "trace ok" }],
    });

    const parent = formatTraceparent(createRootTraceContext())!;
    const run = await engine.trigger(
      "trace_probe",
      { user_role: "admin" },
      {
        triggerEvent: {
          id: "ev-1",
          type: "user.trace_probe",
          source: "test",
          timestamp: new Date(),
          payload: {},
          traceparent: parent,
          traceId: parseTraceparent(parent)?.traceId,
        },
      },
    );

    close();
    expect(run.traceparent).toBeDefined();
    expect(parseTraceparent(run.traceparent!)?.traceId).toBe(parseTraceparent(parent)?.traceId);
    expect(run.steps[0]?.traceparent).toBeDefined();
    expect(parseTraceparent(run.steps[0]!.traceparent!)?.traceId).toBe(
      parseTraceparent(parent)?.traceId,
    );
    expect(run.steps[0]?.traceparent).not.toBe(run.traceparent);
  });
});
