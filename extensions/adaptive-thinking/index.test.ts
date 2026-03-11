import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("adaptive-thinking plugin", () => {
  it("registers a before_model_resolve hook that returns thinking overrides", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();

    plugin.register({
      pluginConfig: { enabled: true, confidenceThreshold: 0.8 },
      on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    } as never);

    const handler = handlers.get("before_model_resolve");
    const result = await handler?.({
      prompt: "debug this failing test in the TypeScript repo",
      currentThinkingDefault: "low",
    });

    expect(result).toEqual({ thinkingLevelOverride: "medium" });
  });

  it("does not leak a thinking override on lightweight turns", async () => {
    const on = vi.fn();
    plugin.register({ pluginConfig: { enabled: true }, on } as never);
    const handler = on.mock.calls[0][1] as (event: Record<string, unknown>) => Promise<unknown>;

    await expect(
      handler({
        prompt: "hi there",
        currentThinkingDefault: "low",
      }),
    ).resolves.toBeUndefined();
  });
});
