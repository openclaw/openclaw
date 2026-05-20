import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../planes/data/db.js";
import { createEventOutbox } from "./outbox.js";

describe("event outbox", () => {
  it("enqueues and flushes deliveries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-outbox-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const outbox = createEventOutbox(db);

    outbox.enqueue("playbook.trigger", { playbookId: "x", input: { a: 1 } });
    expect(outbox.pendingCount()).toBe(1);

    const seen: string[] = [];
    const n = await outbox.flush(async (d) => {
      seen.push(d.kind);
    });
    expect(n).toBe(1);
    expect(seen).toEqual(["playbook.trigger"]);
    expect(outbox.pendingCount()).toBe(0);

    close();
  });

  it("marks exhausted deliveries as dead instead of deleting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-outbox-dlq-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const outbox = createEventOutbox(db);
    const id = outbox.enqueue("playbook.trigger", { playbookId: "x" });
    void id;

    for (let i = 0; i < 5; i++) {
      db.prepare("UPDATE cw_outbox SET next_attempt_at = 0 WHERE is_dead = 0").run();
      await outbox.flush(async () => {
        throw new Error("always fails");
      });
    }

    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadCount()).toBe(1);
    close();
  });
});
