import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { __testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import { isCliProvider } from "./model-selection-cli.js";

describe("isCliProvider", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: { id: "claude-cli", config: { command: "claude" } },
            }
          : undefined,
    });
  });

  afterEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("returns true for setup-registered cli backends", () => {
    expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("accepts the anthropic-cli auth-choice id as a Claude CLI provider alias", () => {
    expect(isCliProvider("anthropic-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for provider ids", () => {
    expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
  });

  it("memoizes lookups by (config reference, normalized provider id)", () => {
    const resolveSpy = vi.fn(({ backend }: { backend: string }) =>
      backend === "claude-cli"
        ? {
            pluginId: "anthropic",
            backend: { id: "claude-cli", config: { command: "claude" } },
          }
        : undefined,
    );
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: resolveSpy,
    });

    const cfgA = {} as OpenClawConfig;
    // First call populates the per-config cache.
    expect(isCliProvider("claude-cli", cfgA)).toBe(true);
    expect(isCliProvider("example-cli", cfgA)).toBe(false);
    const firstCalls = resolveSpy.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // Repeated lookups against the same config reference must not re-enter
    // the setup-registry runtime — that is the path that scales `status` /
    // `doctor` linearly with session count when this cache is absent.
    for (let i = 0; i < 100; i += 1) {
      expect(isCliProvider("claude-cli", cfgA)).toBe(true);
      expect(isCliProvider("example-cli", cfgA)).toBe(false);
    }
    expect(resolveSpy.mock.calls.length).toBe(firstCalls);

    // A different config reference must miss the cache so the WeakMap key
    // boundary stays correct (live config swaps re-evaluate eligibility).
    const cfgB = {} as OpenClawConfig;
    expect(isCliProvider("claude-cli", cfgB)).toBe(true);
    expect(resolveSpy.mock.calls.length).toBeGreaterThan(firstCalls);
  });
});
