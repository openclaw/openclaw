import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("Workboard scratch worker context", () => {
  it("keeps a retained path out of the actual scratch worker prompt", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({
      title: "Scratch context",
      status: "ready",
      workspace: { kind: "worktree", path: "/workspace/repository", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    await store.update(card.id, { workspace: { kind: "scratch" } });
    const run = vi.fn().mockResolvedValue({ runId: "run-scratch" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0]?.[0];
    expect(request?.message).toContain("Workspace: scratch");
    expect(request?.message).not.toContain("/workspace/repository");
  });
});
