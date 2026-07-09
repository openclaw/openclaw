import { describe, expect, it } from "vitest";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { addSession, deleteSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

describe("bash-process-references truncation", () => {
  it("keeps surrogate pairs intact when truncating session names", () => {
    const command = `echo ${"😀".repeat(200)}`;
    addSession(
      createProcessSessionFixture({
        id: "emoji-proc",
        command,
        backgrounded: true,
        startedAt: 1,
      }),
    );

    try {
      const [reference] = listActiveProcessSessionReferences({
        scopeKey: undefined,
      });
      expect(reference).toBeUndefined();
      const scoped = listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2 });
      expect(scoped).toEqual([]);
    } finally {
      deleteSession("emoji-proc");
    }
  });

  it("keeps surrogate pairs intact for scoped background session labels", () => {
    const command = `python ${"😀".repeat(200)}`;
    const session = createProcessSessionFixture({
      id: "emoji-proc-scoped",
      command,
      backgrounded: true,
      startedAt: 1,
    });
    session.scopeKey = "scope-a";
    addSession(session);

    try {
      const [reference] = listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2 });
      expect(reference?.name).not.toContain("�");
      expect(reference?.name.length).toBeLessThanOrEqual(140);
    } finally {
      deleteSession("emoji-proc-scoped");
    }
  });
});
