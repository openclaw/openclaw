import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import {
  withMemoryWorkspaceLock,
  withMemoryWorkspacePreparation,
} from "./memory-workspace-lock.js";
describe("memory workspace ordering", () => {
  let caseId = 0;
  async function makeWorkspace(): Promise<string> {
    return `/memory-workspace-test/case-${caseId++}`;
  }

  it("keeps preparations and writers in the same local FIFO", async () => {
    const workspace = await makeWorkspace();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    const first = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("first preparation");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      order.push("writer");
    });
    const last = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("last preparation");
    });
    try {
      await nextTurn();
      expect(order).toEqual(["first preparation"]);
    } finally {
      release.resolve();
      await Promise.all([first, writer, last]);
    }
    expect(order).toEqual(["first preparation", "writer", "last preparation"]);
  });

  it("reenters a live write scope and serializes sibling preparations", async () => {
    const workspace = await makeWorkspace();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    await withMemoryWorkspaceLock(workspace, async () => {
      const first = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("nested");
        });
      });
      const second = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("second");
      });
      try {
        await entered.promise;
        await nextTurn();
        expect(order).toEqual(["first"]);
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
    });
    expect(order).toEqual(["first", "nested", "second"]);
  });

  it("queues preparation resumed from an expired write scope behind the current writer", async () => {
    const workspace = await makeWorkspace();
    const resume = createDeferred<void>();
    const attempted = createDeferred<void>();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    const retained = await withMemoryWorkspaceLock(workspace, async () => ({
      task: resume.promise.then(async () => {
        attempted.resolve();
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("preparation");
        });
      }),
    }));
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
      order.push("writer");
    });
    try {
      await entered.promise;
      resume.resolve();
      await attempted.promise;
      await nextTurn();
      expect(order).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all([writer, retained.task]);
    }
    expect(order).toEqual(["writer", "preparation"]);
  });
});
