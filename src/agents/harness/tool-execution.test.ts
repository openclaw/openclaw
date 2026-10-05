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
});
