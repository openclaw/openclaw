import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createClaudeCodeVersionRequirement } from "./claude-code-version-requirement.js";

// One backing table shared by separate instances models plugin state across a process restart.
function pluginApi(rows: Map<string, unknown>) {
  const openKeyedStoreV2 = vi.fn(() => ({
    lookup: async (key: string) => rows.get(key),
    register: async (key: string, value: unknown) => void rows.set(key, value),
  }));
  return {
    api: {
      runtime: { state: { openKeyedStoreV2 } },
      logger: { warn: vi.fn() },
    } as unknown as OpenClawPluginApi,
    openKeyedStoreV2,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("starts a restarted process at the version Anthropic last required", async () => {
  const rows = new Map<string, unknown>();
  const first = createClaudeCodeVersionRequirement(pluginApi(rows).api, async () => undefined);
  expect(await first.resolveVersion()).toBeUndefined();
  first.record("2.1.290");
  expect(await first.resolveVersion()).toBe("2.1.290");
  await settle();

  const restarted = createClaudeCodeVersionRequirement(pluginApi(rows).api, async () => undefined);
  expect(await restarted.resolveVersion()).toBe("2.1.290");
});

it("prefers the newer of the installed CLI and the stored requirement", async () => {
  const rows = new Map<string, unknown>([
    ["anthropic-oauth", { version: "2.1.290", learnedAt: 1 }],
  ]);
  const older = createClaudeCodeVersionRequirement(pluginApi(rows).api, async () => "2.1.250");
  expect(await older.resolveVersion()).toBe("2.1.290");
  const newer = createClaudeCodeVersionRequirement(pluginApi(rows).api, async () => "2.1.322");
  expect(await newer.resolveVersion()).toBe("2.1.322");
});

it("keeps working when plugin state is unavailable", async () => {
  const { api } = pluginApi(new Map());
  vi.mocked(api.runtime.state.openKeyedStoreV2).mockImplementation(() => {
    throw new Error("state closed");
  });
  const requirement = createClaudeCodeVersionRequirement(api, async () => "2.1.314");
  await expect(requirement.resolveVersion()).resolves.toBe("2.1.314");
});
