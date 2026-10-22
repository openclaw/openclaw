import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, vi } from "vitest";

export const request: MemoryWorkspaceWatchRequest = {
  agentId: "main",
  settings: {
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 10 },
  },
};

export function memoryWatchFixture(reset: () => void, label: string) {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  const releases: Array<() => void> = [];
  const cleanup: Array<() => void | Promise<void>> = [];
  beforeEach(async () => {
    reset();
    state = await createOpenClawTestState({ label });
    vi.useFakeTimers();
  });
  afterEach(async () => {
    // Unblock discovery/retirement before joining workers and removing their state.
    releases.splice(0).forEach((release) => release());
    for (const close of cleanup.splice(0)) {
      await close();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await state.cleanup();
  });
  return {
    get state() {
      return state;
    },
    cleanup(close: () => void | Promise<void>) {
      cleanup.push(close);
    },
    barrier() {
      const deferred = createDeferred<void>();
      releases.push(deferred.resolve);
      return deferred;
    },
  };
}
