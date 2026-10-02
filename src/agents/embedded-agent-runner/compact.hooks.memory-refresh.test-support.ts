import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getMemoryProviderMock,
  getMemorySearchManagerMock,
  getMemoryProviderRuntimeMock,
} from "./compact.hooks.memory.test-support.js";
import type { CompactHooksQueuedCompaction } from "./compact.hooks.metadata.test-support.js";

type CompactionConfig = (mode: "await" | "off" | "async") => OpenClawConfig;

type DirectRefreshTestParams = {
  compactTesting: () => typeof import("./compact.hooks.owner-test-support.js");
  compactionConfig: CompactionConfig;
  sessionKey: string;
  sessionFile: () => string;
};

/** Registers direct post-compaction provider refresh coverage. */
export function registerDirectProviderRefreshTests(params: DirectRefreshTestParams): void {
  it("refreshes a native provider with the compacted session authority", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    getMemoryProviderRuntimeMock.mockReturnValue({ open: vi.fn() });
    getMemoryProviderMock.mockResolvedValue({
      providerId: "records",
      provider: { refresh, close },
    });
    const audience = {
      kind: "conversation" as const,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: "session-1",
    };

    await params.compactTesting().runPostCompactionSideEffects({
      config: params.compactionConfig("await"),
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      memoryAudience: audience,
      sandboxed: true,
      sessionFile: params.sessionFile(),
    });

    expect(getMemoryProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        context: expect.objectContaining({
          authority: {
            kind: "session",
            sessionKey: params.sessionKey,
            sessionId: "session-1",
            sandboxed: true,
            audience,
          },
        }),
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("awaits an asynchronous caller authority check before native refresh", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    let writerReplaced = false;
    getMemoryProviderRuntimeMock.mockReturnValue({ open: vi.fn() });
    getMemoryProviderMock.mockImplementation(async () => {
      writerReplaced = true;
      return { providerId: "records", provider: { refresh, close } };
    });
    const assertActive = vi.fn(async () => {
      if (writerReplaced) {
        throw new Error("compaction writer replaced");
      }
    });

    await expect(
      params.compactTesting().runPostCompactionSideEffects({
        config: params.compactionConfig("await"),
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile(),
        assertActive,
      }),
    ).rejects.toThrow("compaction writer replaced");

    const context = getMemoryProviderMock.mock.calls[0]?.[0]?.context;
    expect(context?.assertCurrent()).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
}

type QueuedRefreshTestParams = {
  compact: () => CompactHooksQueuedCompaction;
  wrappedArgs: (overrides?: Record<string, unknown>) => Parameters<CompactHooksQueuedCompaction>[0];
  compactionConfig: CompactionConfig;
  sessionKey: string;
  sessionId: () => string;
};

/** Registers queued compaction provider authority coverage. */
export function registerQueuedProviderRefreshTest(params: QueuedRefreshTestParams): void {
  it("preserves an explicit sandbox in queued provider refresh authority", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const audience = {
      kind: "conversation" as const,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId(),
    };
    getMemoryProviderRuntimeMock.mockReturnValue({ open: vi.fn() });
    getMemoryProviderMock.mockResolvedValue({
      providerId: "records",
      provider: { refresh, close },
    });

    try {
      const result = await params.compact()(
        params.wrappedArgs({
          agentId: "main",
          config: params.compactionConfig("await"),
          memoryAudience: audience,
          sandbox: { enabled: true },
        }),
      );
      expect(result.ok).toBe(true);
      expect(getMemoryProviderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            authority: expect.objectContaining({
              kind: "session",
              sandboxed: true,
              audience,
            }),
          }),
        }),
      );
      expect(refresh).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      getMemoryProviderRuntimeMock.mockReturnValue(undefined);
      getMemoryProviderMock.mockReset();
    }
  });
}
