import { expect, it, vi, type Mock } from "vitest";

type MemoryProviderTestParams = {
  memoryCapability: {
    deterministicRecallToolName: string | undefined;
    recallToolNames: readonly string[] | undefined;
  };
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
  writeUsableMemoryTranscript: (sessionFile: string, text: string) => Promise<void>;
  seedSession: (sessionKey: string, sessionId: string, updatedAt?: number) => void;
  expectPrependContextContains: (result: unknown, text: string) => void;
  lastEmbeddedRunParams: () => Record<string, unknown>;
  lastRuntimeEmbeddedRunParams: () => Record<string, unknown>;
};

/** Registers legacy and provider-neutral Active Memory recall, cache, authority, and tool-selection coverage. */
export function registerActiveMemoryProviderTests(params: MemoryProviderTestParams): void {
  it("does not reuse trigger candidates or recall summaries across memory audiences", async () => {
    params.useNativeProvider();
    params.registerPluginConfig({ mode: "always", cacheTtlMs: 1_000 });
    const search = vi.fn(async () => ({ hits: [] }));
    params.getActiveMemoryProvider.mockResolvedValue({
      provider: {
        search,
        capabilities: { candidates: ["trigger"] },
        candidates: vi.fn(async () => ({ hits: [] })),
        close: vi.fn(),
      },
    });
    let recall = 0;
    params.runEmbeddedAgent.mockImplementation(async (run: { sessionFile: string }) => {
      const summary = ++recall === 1 ? "owner-private memory" : "conversation memory";
      await params.writeUsableMemoryTranscript(run.sessionFile, summary);
      return { payloads: [{ text: summary }] };
    });
    const sessionKey = "agent:main:telegram:direct:audience-cache";
    const sessionId = "s-audience-cache";
    const event = {
      prompt: "what did I order last time?",
      currentUserMessage: "what did I order last time?",
      currentUserMessageId: "same-request",
    };
    const context = {
      runId: "run-audience-cache",
      sessionKey,
      sessionId,
      messageProvider: "telegram",
      channelId: "audience-cache",
    };
    params.seedSession(sessionKey, sessionId);

    const ownerResult = await params.runPromptBuild(event, {
      ...context,
      memoryAudience: { kind: "owner-private", agentId: "main" },
    });
    const conversationResult = await params.runPromptBuild(event, {
      ...context,
      memoryAudience: { kind: "conversation", agentId: "main", sessionKey, sessionId },
    });

    params.expectPrependContextContains(ownerResult, "owner-private memory");
    params.expectPrependContextContains(conversationResult, "conversation memory");
    expect(params.getActiveMemoryProvider).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(params.runEmbeddedAgent).toHaveBeenCalledTimes(2);
  });

  it("does not publish or cache recall after the turn's memory audience goes stale", async () => {
    params.useNativeProvider();
    params.registerPluginConfig({ mode: "always", cacheTtlMs: 1_000 });
    let audienceCurrent = true;
    // The host check for the parent turn's audience; a lineage reset during recall revokes it.
    const assertMemoryAudienceCurrent = () => {
      if (!audienceCurrent) {
        throw new Error("memory audience is no longer current");
      }
    };
    let recall = 0;
    params.runEmbeddedAgent.mockImplementation(async (run: { sessionFile: string }) => {
      const summary = ++recall === 1 ? "stale private memory" : "current private memory";
      if (recall === 1) {
        audienceCurrent = false;
      }
      await params.writeUsableMemoryTranscript(run.sessionFile, summary);
      return { payloads: [{ text: summary }] };
    });
    const sessionKey = "agent:main:telegram:direct:audience-stale";
    const sessionId = "s-audience-stale";
    params.seedSession(sessionKey, sessionId);
    const turn = (runId: string) =>
      params.runPromptBuild(
        { prompt: "what did I order last time?" },
        {
          runId,
          sessionKey,
          sessionId,
          messageProvider: "telegram",
          channelId: "audience-stale",
          memoryAudience: { kind: "owner-private", agentId: "main" },
          assertMemoryAudienceCurrent,
        },
      );

    await expect(turn("run-stale-audience")).resolves.toBeUndefined();

    audienceCurrent = true;
    params.expectPrependContextContains(
      await turn("run-current-audience"),
      "current private memory",
    );
    expect(params.runEmbeddedAgent).toHaveBeenCalledTimes(2);
  });

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

  it("passes the parent turn's memory audience to the deep-recall child", async () => {
    const memoryAudience = {
      kind: "conversation",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "s-main",
    } as const;
    await params.runPromptBuild(
      { prompt: "what wings should i order?" },
      { sessionKey: "agent:main:main", sessionId: "s-main", memoryAudience },
    );
    expect(params.lastRuntimeEmbeddedRunParams().memoryAudience).toBe(memoryAudience);
  });

  it("runs provider-direct trigger recall without a deterministic recall tool", async () => {
    params.memoryCapability.deterministicRecallToolName = undefined;
    params.memoryCapability.recallToolNames = ["record_find"];
    params.useNativeProvider();
    params.getActiveMemoryProvider.mockResolvedValueOnce({
      providerId: "records",
      provider: {
        search: vi.fn(async () => ({ hits: [] })),
        capabilities: { candidates: ["trigger"] },
        candidates: vi.fn(async () => ({ hits: [] })),
        close: vi.fn(async () => {}),
      },
    });
    await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        sessionKey: "agent:main:telegram:direct:owner",
        sessionId: "owner-session",
        messageProvider: "telegram",
        channelId: "owner",
        memoryAudience: { kind: "owner-private", agentId: "main" },
      },
    );
    expect(params.getActiveMemoryProvider).toHaveBeenCalledOnce();
  });

  it("uses the selected provider's declared deep-recall tools by default", async () => {
    params.memoryCapability.recallToolNames = ["record_find", "record_get"];
    params.registerPluginConfig({});
    await params.runPromptBuild({ prompt: "What did we decide?" });
    expect(params.lastEmbeddedRunParams().toolsAllow).toEqual(["record_find", "record_get"]);
  });

  it("serves native trigger recall under the turn's session authority and audience", async () => {
    params.useNativeProvider();
    const assertMemoryAudienceCurrent = vi.fn();
    const memoryAudience = { kind: "owner-private", agentId: "main" } as const;
    params.getActiveMemoryProvider.mockResolvedValueOnce({
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

    const result = await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        sessionKey: "agent:main:telegram:direct:owner",
        sessionId: "owner-session",
        messageProvider: "telegram",
        channelId: "owner",
        memoryAudience,
        assertMemoryAudienceCurrent,
      },
    );

    params.expectPrependContextContains(result, "Prefer aisle seats. (Source: Travel preference)");
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(params.getActiveMemoryProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          authority: {
            kind: "session",
            sessionKey: "agent:main:telegram:direct:owner",
            sessionId: "owner-session",
            sandboxed: false,
            audience: memoryAudience,
          },
        }),
      }),
    );
    expect(assertMemoryAudienceCurrent).toHaveBeenCalled();
  });

  it("skips native trigger recall when tool policy denies a declared recall tool", async () => {
    params.memoryCapability.recallToolNames = ["record_find", "record_get"];
    params.useNativeProvider();
    await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        sessionKey: "agent:main:telegram:direct:owner",
        sessionId: "owner-session",
        messageProvider: "telegram",
        channelId: "owner",
        toolAuthority: {
          fingerprint: "record-find-denied",
          allows: (toolName: string) => toolName !== "record_find",
          assertActive: () => undefined,
        },
      },
    );
    expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["denies the deterministic recall tool", "memory_search", "memory_search"],
    ["has no deterministic recall tool", undefined, undefined],
  ])("skips legacy trigger recall when the owner %s", async (_label, toolName, denied) => {
    params.memoryCapability.deterministicRecallToolName = toolName;
    await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        sessionKey: "agent:main:telegram:direct:owner",
        sessionId: "owner-session",
        messageProvider: "telegram",
        channelId: "owner",
        toolAuthority: {
          fingerprint: "legacy-policy",
          allows: (name: string) => name !== denied,
          assertActive: () => undefined,
        },
      },
    );
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
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
