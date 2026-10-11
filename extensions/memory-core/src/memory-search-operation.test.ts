import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createPluginRecord,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { rankShortTermPromotionCandidates } from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetMemoryCoreDreamingStateForTests();
  vi.unstubAllEnvs();
});

it("makes routed CLI recalls available to dreaming in the requested agent workspace", async () => {
  const root = roots.make("memory-search-recall-");
  const workspaceDir = path.join(root, "qa");
  const otherWorkspace = path.join(root, "main");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const { registry, config } = createPluginRegistryFixture({
    agents: { entries: { main: { workspace: otherWorkspace }, qa: { workspace: workspaceDir } } },
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
  });
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({ id: "memory-core", kind: "memory", memorySlotSelected: true }),
    register: plugin.register,
  });
  // A live Gateway initializes state inside its plugin instance, never the library fallback.
  resetMemoryCoreDreamingStateForTests();
  const runtime = registry.registry.memoryCapabilities[0]?.capability.runtime;
  assert(runtime?.searchForCli);
  const hit = {
    path: "memory/2026-10-10.md",
    startLine: 1,
    endLine: 1,
    score: 0.9,
    snippet: "NEBULA-73 belongs in durable memory.",
    source: "memory" as const,
  };
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, hit.path), `${hit.snippet}\n`);
  const search = vi.fn(async () => [hit]);
  const manager: MemorySearchManager = {
    search,
    status: () => ({ backend: "builtin", provider: "none", dirty: false, workspaceDir }),
    readFile: async ({ relPath }) => ({ status: "not_found", path: relPath, text: "" }),
    probeEmbeddingAvailability: async () => ({ ok: false, error: "Unused fixture probe" }),
    probeVectorAvailability: async () => false,
  };
  try {
    for (const query of ["nebula canary", "durable memory", "which canary"]) {
      const result = await runtime.searchForCli({
        manager,
        cfg: config,
        agentId: "qa",
        query,
        assertCurrent() {},
      });
      expect(result.results).toEqual([hit]);
    }
    expect(search).toHaveBeenLastCalledWith("which canary", {
      sessionKey: "agent:qa:cli:direct:memory-search",
      maxResults: undefined,
      minScore: undefined,
    });
    // Read through the same durable store as a later dreaming sweep.
    await configureMemoryCoreDreamingStateForTests();
    const thresholds = { minScore: 0, minRecallCount: 3, minUniqueQueries: 3 };
    expect(await rankShortTermPromotionCandidates({ workspaceDir, ...thresholds })).toEqual([
      expect.objectContaining({ path: hit.path, recallCount: 3, uniqueQueries: 3 }),
    ]);
    expect(
      await rankShortTermPromotionCandidates({ workspaceDir: otherWorkspace, ...thresholds }),
    ).toEqual([]);
  } finally {
    await disposePluginRegistryInstances(registry.registry);
  }
});
