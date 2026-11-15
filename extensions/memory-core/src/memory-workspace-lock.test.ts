import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  withMemoryWorkspaceLock as write,
  withMemoryWorkspacePreparation as prepare,
} from "./memory-workspace-lock.js";

let caseId = 0;
function setup() {
  const order: string[] = [];
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    workspace: `/memory-workspace-test/case-${caseId++}`,
    order,
    entered,
    release,
    step: (name: string) => async () => {
      order.push(name);
    },
    hold: (name: string, after?: () => Promise<void>) => async () => {
      order.push(name);
      entered.resolve();
      await release.promise;
      if (after) {
        await after();
      }
    },
    async expectBlocked(expected: string[], ...pending: Promise<unknown>[]) {
      try {
        await nextTurn();
        expect(order).toEqual(expected);
      } finally {
        release.resolve();
        await Promise.all(pending);
      }
    },
  };
}

describe("memory workspace ordering", () => {
  it("serializes writers from overlapping module generations", async () => {
    const f = setup();
    const predecessor = write(f.workspace, f.hold("predecessor"));
    await f.entered.promise;
    vi.resetModules();
    const successorModule = await import("./memory-workspace-lock.js");
    expect(successorModule.withMemoryWorkspaceLock).not.toBe(write);
    const successor = successorModule.withMemoryWorkspaceLock(f.workspace, f.step("successor"));
    await f.expectBlocked(["predecessor"], predecessor, successor);
    expect(f.order).toEqual(["predecessor", "successor"]);
  });

  it("keeps preparations and writers in the same local FIFO", async () => {
    const f = setup();
    const first = prepare(f.workspace, f.hold("first preparation"));
    await f.entered.promise;
    const writer = write(f.workspace, f.step("writer"));
    const last = prepare(f.workspace, f.step("last preparation"));
    await f.expectBlocked(["first preparation"], first, writer, last);
    expect(f.order).toEqual(["first preparation", "writer", "last preparation"]);
  });

  it("reenters a live write scope and serializes sibling preparations", async () => {
    const f = setup();
    await write(f.workspace, async () => {
      const first = prepare(
        f.workspace,
        f.hold("first", () => prepare(f.workspace, f.step("nested"))),
      );
      const second = prepare(f.workspace, f.step("second"));
      await f.entered.promise;
      await f.expectBlocked(["first"], first, second);
    });
    expect(f.order).toEqual(["first", "nested", "second"]);
  });

  it("queues preparation resumed from an expired write scope behind the current writer", async () => {
    const f = setup();
    const resume = createDeferred<void>();
    const attempted = createDeferred<void>();
    const retained = await write(f.workspace, async () => ({
      task: resume.promise.then(async () => {
        attempted.resolve();
        await prepare(f.workspace, f.step("preparation"));
      }),
    }));
    const writer = write(f.workspace, async () => {
      f.entered.resolve();
      await f.release.promise;
      f.order.push("writer");
    });
    await f.entered.promise;
    resume.resolve();
    await attempted.promise;
    await f.expectBlocked([], writer, retained.task);
    expect(f.order).toEqual(["writer", "preparation"]);
  });
});
