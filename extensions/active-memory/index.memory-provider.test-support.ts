import { expect, it, vi, type Mock } from "vitest";

type MemoryProviderTestParams = {
  getActiveMemoryProvider: Mock;
  getActiveMemorySearchManager: Mock;
  /** Selects a slot owner that registers the provider-neutral runtime. */
  useNativeProvider: () => void;
  runEmbeddedAgent: Mock;
  registerPluginConfig: (overrides: Record<string, unknown>) => void;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Registers legacy and provider-neutral Active Memory trigger admission coverage. */
export function registerActiveMemoryProviderTests(params: MemoryProviderTestParams): void {
  it.each([" \n "])(
    "does not recall historical text for an explicit empty request %j",
    async (currentUserMessage) => {
      params.useNativeProvider();
      params.registerPluginConfig({ mode: "always" });
      const search = vi.fn(async () => ({ hits: [] }));
      params.getActiveMemoryProvider.mockResolvedValue({
        provider: {
          search,
          capabilities: { candidates: ["trigger"] },
          candidates: vi.fn(async () => ({ hits: [] })),
          close: vi.fn(),
        },
      });
      await params.runPromptBuild({
        prompt: "What do you remember about my preferences?",
        currentUserMessage,
        currentUserMessageId: "empty-admission",
        messages: [{ role: "user", content: "What do you remember about my preferences?" }],
      });
      expect(search).not.toHaveBeenCalled();
      expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("reuses one trigger admission across history changes and keeps authority separate", async () => {
    params.useNativeProvider();
    params.registerPluginConfig({ mode: "escalate" });
    const search = vi.fn(async () => ({ hits: [] }));
    params.getActiveMemoryProvider.mockResolvedValue({
      provider: {
        search,
        capabilities: { candidates: ["trigger"] },
        candidates: vi.fn(async () => ({ hits: [] })),
        close: vi.fn(),
      },
    });
    for (const [history, fingerprint, admission] of [
      ["old history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-b", "same-admission"],
      ["rebuilt history", "authority-b", "new-admission"],
    ] as const) {
      await params.runPromptBuild(
        {
          prompt: history,
          currentUserMessage: "ok",
          currentUserMessageId: admission,
          messages: [{ role: "user", content: history }],
        },
        {
          runId: "trigger-rebuild",
          toolAuthority: {
            fingerprint,
            allows: () => true,
            assertActive: () => undefined,
          },
        },
      );
    }
    expect(search).toHaveBeenCalledTimes(3);
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("serves native trigger recall through the provider instead of a legacy manager", async () => {
    params.useNativeProvider();
    params.registerPluginConfig({ mode: "escalate" });
    params.getActiveMemoryProvider.mockResolvedValue({
      provider: {
        search: vi.fn(async () => ({ hits: [] })),
        capabilities: { candidates: ["trigger"] },
        candidates: vi.fn(async () => ({
          hits: [
            {
              reference: { providerId: "records", id: "travel" },
              score: 1,
              excerpt: "Prefer aisle seats.",
              citations: [{ label: "Travel preference" }],
              automaticRecall: { eligible: true, triggers: "booking a flight" },
            },
          ],
        })),
        close: vi.fn(),
      },
    });
    const result = await params.runPromptBuild({
      prompt: "Help when booking a flight",
      currentUserMessage: "Help when booking a flight",
      currentUserMessageId: "native-trigger",
      messages: [{ role: "user", content: "Help when booking a flight" }],
    });
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("Prefer aisle seats. (Source: Travel preference)");
  });

  it.each([" \n "])(
    "does not recall legacy historical text for an explicit empty request %j",
    async (currentUserMessage) => {
      params.registerPluginConfig({ mode: "always" });
      const search = vi.fn(async () => []);
      params.getActiveMemorySearchManager.mockResolvedValue({
        manager: { search, listTriggerCandidates: vi.fn(async () => []) },
      } as never);
      await params.runPromptBuild({
        prompt: "What do you remember about my preferences?",
        currentUserMessage,
        currentUserMessageId: "empty-admission",
        messages: [{ role: "user", content: "What do you remember about my preferences?" }],
      });
      expect(search).not.toHaveBeenCalled();
      expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("reuses one legacy trigger admission across history changes and keeps authority separate", async () => {
    params.registerPluginConfig({ mode: "escalate" });
    const search = vi.fn(async () => []);
    params.getActiveMemorySearchManager.mockResolvedValue({
      manager: { search, listTriggerCandidates: vi.fn(async () => []) },
    } as never);
    for (const [history, fingerprint, admission] of [
      ["old history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-b", "same-admission"],
      ["rebuilt history", "authority-b", "new-admission"],
    ] as const) {
      await params.runPromptBuild(
        {
          prompt: history,
          currentUserMessage: "ok",
          currentUserMessageId: admission,
          messages: [{ role: "user", content: history }],
        },
        {
          runId: "trigger-rebuild",
          toolAuthority: { fingerprint, allows: () => true, assertActive: () => undefined },
        },
      );
    }
    expect(search).toHaveBeenCalledTimes(3);
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });
}
