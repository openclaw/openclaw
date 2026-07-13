import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("onepassword plugin", () => {
  it("opens bounded fail-closed grant and audit stores", () => {
    const store = {
      register: vi.fn(),
      lookup: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(async () => []),
    };
    const openKeyedStore = vi.fn(() => store);
    const registerCli = vi.fn();
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "onepassword",
        name: "1Password",
        source: "test",
        config: {},
        runtime: {
          state: {
            openKeyedStore,
            resolveStateDir: () => "/tmp/openclaw-onepassword-test",
          },
        } as never,
        registerCli,
        registerTool,
      }),
    );

    expect(openKeyedStore).toHaveBeenNthCalledWith(1, {
      namespace: "grants",
      maxEntries: 1_024,
      overflowPolicy: "evict-oldest",
    });
    expect(openKeyedStore).toHaveBeenNthCalledWith(2, {
      namespace: "audit",
      maxEntries: 40_000,
      overflowPolicy: "evict-oldest",
    });
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
