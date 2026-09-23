import { describe, expect, it, vi } from "vitest";
import { createAgentHarnessToolExecutionRegistry } from "./tool-execution.js";

describe("createAgentHarnessToolExecutionRegistry", () => {
  it("publishes the execution before a synchronous re-entry", async () => {
    const registry = createAgentHarnessToolExecutionRegistry<{ id: string }, string>((call) => [
      call.id,
    ]);
    const call = { id: "call-1" };
    const nestedStart = vi.fn(async () => "duplicate");

    const owner = registry.claim(call, async () => {
      const replay = registry.claim(call, nestedStart);
      expect(replay.replayed).toBe(true);
      expect(replay.execution).toBe(registry.get(call));
      return "owner";
    });

    await expect(owner.execution).resolves.toBe("owner");
    expect(nestedStart).not.toHaveBeenCalled();
  });

  it("turns a synchronous start throw into the shared rejection", async () => {
    const registry = createAgentHarnessToolExecutionRegistry<{ id: string }, string>((call) => [
      call.id,
    ]);
    const call = { id: "call-1" };
    const owner = registry.claim(call, () => {
      throw new Error("boom");
    });

    await expect(owner.execution).rejects.toThrow("boom");
    expect(registry.claim(call, async () => "duplicate").execution).toBe(owner.execution);
  });

  it("drains both fulfilled and rejected executions", async () => {
    const registry = createAgentHarnessToolExecutionRegistry<{ id: string }, string>((call) => [
      call.id,
    ]);
    let release!: () => void;
    registry.claim({ id: "pending" }, () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => "ok"),
    );
    registry.claim({ id: "failed" }, async () => {
      throw new Error("expected");
    });

    let drained = false;
    const drain = registry.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(drained).toBe(true);
  });
});
