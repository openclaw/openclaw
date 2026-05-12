import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginCliBackendEntry } from "../plugins/cli-backends.runtime.js";
import { __testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import { isCliProvider } from "./model-selection-cli.js";

const resolveRuntimeCliBackendsMock = vi.hoisted(() =>
  vi.fn<() => PluginCliBackendEntry[]>(() => []),
);
vi.mock("../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: resolveRuntimeCliBackendsMock,
}));

describe("isCliProvider", () => {
  beforeEach(() => {
    resolveRuntimeCliBackendsMock.mockReset();
    resolveRuntimeCliBackendsMock.mockReturnValue([]);
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

  it("memoizes the setup-manifest branch by (config reference, normalized provider id)", () => {
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

  it("re-reads the active runtime registry on every call so late-loaded backends are picked up", () => {
    // Codex review feedback (openclaw/openclaw#80717) flagged that caching the
    // whole `isCliProvider` result would lock in a stale `false` once a
    // runtime plugin registers a CLI backend mid-process. The memoization is
    // narrowed to the setup-manifest branch; the runtime-registry branch
    // (`resolveRuntimeCliBackends`) must be re-evaluated on every call.
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });
    const cfg = {} as OpenClawConfig;

    // First call: runtime registry empty, setup lookup misses. Result: false.
    resolveRuntimeCliBackendsMock.mockReturnValue([]);
    expect(isCliProvider("claude-cli", cfg)).toBe(false);
    const callsAfterFirst = resolveRuntimeCliBackendsMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Runtime registry now exposes the backend (e.g. a plugin finished
    // loading). The next call must observe the new state, not a cached
    // `false`, even though `(cfg, "claude-cli")` is the same cache key.
    resolveRuntimeCliBackendsMock.mockReturnValue([
      {
        id: "claude-cli",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ]);
    expect(isCliProvider("claude-cli", cfg)).toBe(true);
    expect(resolveRuntimeCliBackendsMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("re-reads config-declared backends on every call so config mutations are picked up", () => {
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });
    const cfg: OpenClawConfig = {
      agents: { defaults: { cliBackends: {} } },
    } as unknown as OpenClawConfig;

    // Branch 1 currently empty, branches 2+3 also miss → false.
    expect(isCliProvider("claude-cli", cfg)).toBe(false);

    // Config-declared backends mutate (e.g. user edits live config in place).
    // Even though the cache holds a `false` for the setup-manifest branch,
    // branch 1 must still flip the answer to `true`.
    (
      cfg as { agents: { defaults: { cliBackends: Record<string, unknown> } } }
    ).agents.defaults.cliBackends = {
      "claude-cli": {},
    };
    expect(isCliProvider("claude-cli", cfg)).toBe(true);
  });
});
