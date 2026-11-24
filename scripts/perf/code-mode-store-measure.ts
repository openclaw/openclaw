// Synthetic owner workload. Run on alternating source roots with --expose-gc.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolSearchCatalogRef } from "../../src/agents/tool-search-types.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const root = path.resolve(process.argv[2] ?? ".");
const source = (file: string) => pathToFileURL(path.join(root, "src", file)).href;
const { SessionManager }: typeof import("../../src/agents/sessions/session-manager.js") =
  await import(source("agents/sessions/session-manager.ts"));
const {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
  disposeCodeModeSessionStore,
}: typeof import("../../src/agents/code-mode-session-store.js") = await import(
  source("agents/code-mode-session-store.ts")
);
const { withOpenClawTestState }: typeof import("../../src/test-utils/openclaw-test-state.js") =
  await import(source("test-utils/openclaw-test-state.ts"));
const { upsertSessionEntryCore }: typeof import("../../src/config/sessions/session-accessor.js") =
  await import(source("config/sessions/session-accessor.ts"));
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState({ label: "store-measure" }, async (state: { root: string }) => {
    const target = {
      agentId: "main",
      sessionId: "store-measure",
      sessionKey: "agent:main:store-measure",
      storePath: path.join(state.root, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const seed = await SessionManager.openAsync(target, state.root);
    await seed.appendCustomEntryAsync("openclaw.code-mode-store", {
      set: { earlier: "retained" },
      delete: [],
      networkContent: { earlier: false },
    });
    for (let index = 0; index < 256; index++) {
      await seed.appendMessageAsync({ role: "user", content: "x".repeat(8192), timestamp: index });
    }
    for (let sample = 0; sample < 6; sample++) {
      const manager = await SessionManager.openAsync(target, state.root, {
        maxEvents: 32,
        maxBytes: 128 * 1024,
      });
      const owner: ToolSearchCatalogRef = {
        current: {
          entries: [],
          counterScope: "probe",
          searchCount: 0,
          describeCount: 0,
          callCount: 0,
        },
      };
      bindCodeModeSessionStore(owner, manager);
      const ctx = { catalogRef: owner, sessionId: target.sessionId, runId: `run-${sample}` };
      globalThis.gc?.();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      const before = performance.now();
      const first = await createCodeModeSessionStoreAccess(ctx, new AbortController().signal).load(
        "earlier",
      );
      const firstMs = performance.now() - before;
      const cached = performance.now();
      const second = await createCodeModeSessionStoreAccess(ctx, new AbortController().signal).load(
        "earlier",
      );
      const cachedMs = performance.now() - cached;
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sampledAllocatedBytes = sumSampledHeapBytes(profile.head);
      assert.deepEqual(first, { value: "retained", networkContent: false });
      assert.deepEqual(second, first);
      console.log(
        JSON.stringify({
          sample,
          phase: sample === 0 ? "cold" : "warm",
          firstMs,
          cachedMs,
          allocatedBytes: sampledAllocatedBytes,
        }),
      );
      owner.current = undefined;
      disposeCodeModeSessionStore(owner);
    }
  });
} finally {
  inspector.disconnect();
}
