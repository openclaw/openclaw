import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";

describe("memory background context", () => {
  it("follows the latest registration instead of the generation that loaded the module", async () => {
    vi.resetModules();
    const generation = new AsyncLocalStorage<string>();
    const context = await generation.run("first Gateway", () => import("./background-context.js"));

    // An in-process restart re-registers the plugin without re-evaluating the module.
    generation.run("restarted Gateway", () => context.captureMemoryBackgroundContext());

    const observed = generation.run("turn", () =>
      context.resolveMemoryBackgroundContext()(() => generation.getStore()),
    );
    expect(observed).toBe("restarted Gateway");
  });
});
