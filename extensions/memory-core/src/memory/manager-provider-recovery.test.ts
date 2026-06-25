// Memory Core tests cover fallback provider recovery behavior.
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemoryProviderLifecycleState } from "./manager-provider-state.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(),
  resolveEmbeddingProviderFallbackModel: (
    providerId: string,
    fallbackSourceModel: string,
  ) => (providerId === "local" ? "local-model" : fallbackSourceModel),
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderAdapterId: () => undefined,
  resolveEmbeddingProviderAdapterTransport: () => undefined,
}));

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

function createMockProvider(id: string, model?: string): EmbeddingProvider {
  return {
    id,
    model: model ?? `${id}-model`,
    embedQuery: async () => [0.1, 0.2, 0.3],
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  };
}

class RecoveryTestHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "test-agent";
  protected readonly workspaceDir = "/tmp/openclaw-memory-recovery-test";
  protected readonly settings: ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle: MemoryProviderLifecycleState =
    { mode: "active", providerId: "openai" };
  protected db = {} as DatabaseSync;

  constructor() {
    super();
    this.settings = {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "local",
      sync: {},
      remote: {},
      store: { databasePath: "/tmp/test.db" },
    } as unknown as ResolvedMemorySearchConfig;
  }

  // Expose protected methods for testing
  async testAttemptPrimaryProviderRecovery(cooldownMs: number): Promise<boolean> {
    return this.attemptPrimaryProviderRecovery(cooldownMs);
  }

  async testActivateFallbackProvider(reason: string): Promise<boolean> {
    return this.activateFallbackProvider(reason);
  }

  getProvider(): EmbeddingProvider | null {
    return this.provider;
  }

  setProvider(provider: EmbeddingProvider | null): void {
    this.provider = provider;
  }

  getFallbackFrom(): string | undefined {
    return this.fallbackFrom;
  }

  getFallbackActivatedAtMs(): number | undefined {
    return this.fallbackActivatedAtMs;
  }

  setFallbackActivatedAtMs(value: number | undefined): void {
    this.fallbackActivatedAtMs = value;
  }

  getLifecycle() {
    return this.providerLifecycle;
  }

  setProviderLifecycle(state: MemoryProviderLifecycleState): void {
    this.providerLifecycle = state;
  }

  protected computeProviderKey(): string {
    return "test-key";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected override resolveBatchConfig() {
    return this.batch;
  }

  protected async sync(): Promise<void> {}

  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(
    _entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {}
}

describe("fallback provider recovery", () => {
  let harness: RecoveryTestHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = new RecoveryTestHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not attempt recovery when not in fallback mode", async () => {
    harness.setProvider(createMockProvider("openai"));
    const result = await harness.testAttemptPrimaryProviderRecovery(60_000);
    expect(result).toBe(false);
  });

  it("does not attempt recovery before cooldown elapses", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const mockCreate = vi.mocked(createEmbeddingProvider);

    // Simulate being in fallback state
    harness.setProvider(createMockProvider("local"));
    // Set fallbackFrom and timestamp manually to simulate activated fallback
    (harness as unknown as { fallbackFrom: string }).fallbackFrom = "openai";
    harness.setFallbackActivatedAtMs(Date.now());

    // Advance time by only 30s (less than 60s cooldown)
    vi.advanceTimersByTime(30_000);

    const result = await harness.testAttemptPrimaryProviderRecovery(60_000);
    expect(result).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("attempts recovery after cooldown and succeeds when primary is available", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const mockCreate = vi.mocked(createEmbeddingProvider);
    const restoredProvider = createMockProvider("openai", "text-embedding-3-small");

    mockCreate.mockResolvedValueOnce({
      provider: restoredProvider,
      requestedProvider: "openai",
      runtime: undefined,
    });

    // Simulate being in fallback state
    const fallbackProvider = createMockProvider("local");
    harness.setProvider(fallbackProvider);
    (harness as unknown as { fallbackFrom: string }).fallbackFrom = "openai";
    harness.setFallbackActivatedAtMs(Date.now());

    // Advance time past cooldown
    vi.advanceTimersByTime(61_000);

    const result = await harness.testAttemptPrimaryProviderRecovery(60_000);
    expect(result).toBe(true);
    expect(harness.getProvider()).toBe(restoredProvider);
    expect(harness.getFallbackFrom()).toBeUndefined();
    expect(harness.getFallbackActivatedAtMs()).toBeUndefined();
  });

  it("resets cooldown timer when primary is still unavailable", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const mockCreate = vi.mocked(createEmbeddingProvider);

    mockCreate.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Simulate being in fallback state
    harness.setProvider(createMockProvider("local"));
    (harness as unknown as { fallbackFrom: string }).fallbackFrom = "openai";
    const originalTimestamp = Date.now();
    harness.setFallbackActivatedAtMs(originalTimestamp);

    // Advance time past cooldown
    vi.advanceTimersByTime(61_000);

    const result = await harness.testAttemptPrimaryProviderRecovery(60_000);
    expect(result).toBe(false);
    // Timestamp should be updated to allow next retry after another cooldown
    expect(harness.getFallbackActivatedAtMs()).toBeGreaterThan(originalTimestamp);
  });

  it("resets cooldown timer when primary returns null provider", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const mockCreate = vi.mocked(createEmbeddingProvider);

    mockCreate.mockResolvedValueOnce({
      provider: null,
      requestedProvider: "openai",
      runtime: undefined,
    });

    // Simulate being in fallback state
    harness.setProvider(createMockProvider("local"));
    (harness as unknown as { fallbackFrom: string }).fallbackFrom = "openai";
    const originalTimestamp = Date.now();
    harness.setFallbackActivatedAtMs(originalTimestamp);

    // Advance time past cooldown
    vi.advanceTimersByTime(61_000);

    const result = await harness.testAttemptPrimaryProviderRecovery(60_000);
    expect(result).toBe(false);
    expect(harness.getFallbackActivatedAtMs()).toBeGreaterThan(originalTimestamp);
  });

  it("records fallbackActivatedAtMs when fallback is activated", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const mockCreate = vi.mocked(createEmbeddingProvider);
    const fallbackProvider = createMockProvider("local");

    mockCreate.mockResolvedValueOnce({
      provider: fallbackProvider,
      requestedProvider: "local",
      runtime: undefined,
    });

    // Set up primary provider that will fail
    harness.setProvider(createMockProvider("openai"));
    harness.setProviderLifecycle({ mode: "active", providerId: "openai" });

    const beforeActivation = Date.now();
    await harness.testActivateFallbackProvider("connection refused");
    const afterActivation = Date.now();

    expect(harness.getFallbackActivatedAtMs()).toBeGreaterThanOrEqual(beforeActivation);
    expect(harness.getFallbackActivatedAtMs()).toBeLessThanOrEqual(afterActivation);
    expect(harness.getFallbackFrom()).toBe("openai");
  });
});
