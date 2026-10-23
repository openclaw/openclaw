import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getMemoryProviderMock,
  getMemoryProviderRuntimeMock,
} from "./compact.hooks.memory.test-support.js";
import type { CompactHooksQueuedCompaction } from "./compact.hooks.metadata.test-support.js";

type CompactionConfig = (mode: "await" | "off" | "async") => OpenClawConfig;

export function registerDirectProviderRefreshTests(params: {
  compactTesting: () => typeof import("./compact.hooks.owner-test-support.js");
  compactionConfig: CompactionConfig;
  sessionKey: string;
  sessionFile: () => string;
}): void {
  it("awaits an asynchronous caller authority check before native refresh", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    let writerReplaced = false;
    getMemoryProviderRuntimeMock.mockReturnValue({ open: vi.fn() });
    getMemoryProviderMock.mockImplementation(async () => {
      writerReplaced = true;
      return { providerId: "records", provider: { refresh, close } };
    });
    await expect(
      params.compactTesting().runPostCompactionSideEffects({
        config: params.compactionConfig("await"),
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile(),
        assertActive: async () => {
          if (writerReplaced) {
            throw new Error("compaction writer replaced");
          }
        },
      }),
    ).rejects.toThrow("compaction writer replaced");

    const context = getMemoryProviderMock.mock.calls[0]?.[0]?.context;
    expect(context?.assertCurrent()).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
}

export function registerQueuedProviderRefreshTest(params: {
  compact: () => CompactHooksQueuedCompaction;
  wrappedArgs: (overrides?: Record<string, unknown>) => Parameters<CompactHooksQueuedCompaction>[0];
  compactionConfig: CompactionConfig;
  sessionKey: string;
  sessionId: () => string;
}): void {
  it("preserves an explicit sandbox in queued provider refresh authority", async () => {
    // The harness resets modules before loading compaction; bind in that same module lifetime.
    const { bindMemoryProvider } = await import("../../plugins/memory-provider-adapter.js");
    const audience = {
      kind: "conversation" as const,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId(),
    };
    const provider = {
      capabilities: {
        sources: ["sessions"],
        candidates: [],
        pagination: false,
        projectFilter: false,
      },
      search: async () => ({ hits: [] }),
      get: async () => ({ status: "not_found" }),
      health: async () => ({ status: "ready" }),
      refresh: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies Parameters<typeof bindMemoryProvider>[0];
    getMemoryProviderRuntimeMock.mockReturnValue({ open: vi.fn() });
    getMemoryProviderMock.mockResolvedValue({
      providerId: "records",
      provider: bindMemoryProvider(provider, "records", {
        authority: { kind: "host", operation: "test-refresh" },
        assertCurrent: () => {},
      }),
    });

    const result = await params.compact()(
      params.wrappedArgs({
        agentId: "main",
        config: params.compactionConfig("await"),
        memoryAudience: audience,
        sandbox: { enabled: true },
      }),
    );
    expect(result.ok).toBe(true);
    expect(getMemoryProviderMock).toHaveBeenCalledOnce();
    expect(getMemoryProviderMock.mock.calls[0]?.[0]?.context.authority).toMatchObject({
      kind: "session",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId(),
      sandboxed: true,
      audience,
    });
    expect(provider.refresh).toHaveBeenCalledOnce();
    expect(provider.close).toHaveBeenCalledOnce();
  });
}
