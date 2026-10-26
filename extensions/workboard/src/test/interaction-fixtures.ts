import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { vi } from "vitest";
import type { WorkboardStore } from "../store.js";

export function toolsByName(tools: AnyAgentTool[]) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Set<string>();
  for (let index = 0; index < 40; index++) {
    const prefix = (await store.create({ title: `Card ${index}` })).id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.add(prefix);
  }
  throw new Error("could not create cards with a shared prefix");
}

export function createSandboxRuntime(sandboxed = false) {
  const authority = () => ({ sandboxed, workspaceAccess: "rw" as const });
  return {
    resolveWorkspaceAuthority: vi.fn(authority),
    prepareWorkspaceAuthority: vi.fn(async () => authority()),
  };
}

export function createWorktreeRuntime(overrides: Partial<PluginRuntime["worktrees"]> = {}) {
  return {
    resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    release: vi.fn(),
    removeIfLossless: vi.fn(),
    ...overrides,
  };
}
