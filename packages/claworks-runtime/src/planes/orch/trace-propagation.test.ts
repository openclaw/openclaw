import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventKernel } from "../../kernel/event-kernel.js";
import {
  formatTraceparent,
  createRootTraceContext,
  parseTraceparent,
} from "../../kernel/trace-context.js";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";
import type { PlaybookDefinition } from "./playbook-types.js";

describe("trace propagation", () => {
  it("passes traceparent from EventKernel publish to PlaybookRun and StepLog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-trace-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const incoming = formatTraceparent(createRootTraceContext())!;
    const published: Array<{ type: string; traceparent?: string }> = [];

    const playbookEngine = createPlaybookEngine({
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
      publishEvent: async (type, _source, _payload, _correlationId, traceparent) => {
        published.push({ type, traceparent });
      },
    });

    const def: PlaybookDefinition = {
      id: "trace_flow",
      name: "TraceTest",
      pack: "test",
      trigger: { kind: "event", pattern: "test.trace" },
      priority: 0,
      steps: [
        {
          kind: "publish_event",
          id: "child_evt",
          eventType: "test.trace.child",
          payload: { ok: true },
        },
      ],
    };

    await playbookEngine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "Test",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["trace_flow"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const kernel = createEventKernel({ playbookEngine, db });
    kernel.matcher.load(playbookEngine.list());
    await kernel.start();
    await kernel.publish("test.trace", "test", { user: "alice" }, { traceparent: incoming });

    const runs = await playbookEngine.listRuns({ playbookId: "trace_flow", limit: 1 });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("completed");
    expect(run.traceparent).toBeDefined();

    const incomingParsed = parseTraceparent(incoming)!;
    const runParsed = parseTraceparent(run.traceparent!)!;
    expect(runParsed.traceId).toBe(incomingParsed.traceId);
    expect(runParsed.spanId).not.toBe(incomingParsed.spanId);

    expect(run.steps).toHaveLength(1);
    const stepParsed = parseTraceparent(run.steps[0]!.traceparent!)!;
    expect(stepParsed.traceId).toBe(incomingParsed.traceId);
    expect(stepParsed.spanId).not.toBe(runParsed.spanId);

    const childPublish = published.find((e) => e.type === "test.trace.child");
    expect(childPublish?.traceparent).toBeDefined();
    const childParsed = parseTraceparent(childPublish!.traceparent!)!;
    expect(childParsed.traceId).toBe(incomingParsed.traceId);

    await kernel.stop();
    close();
  });
});
