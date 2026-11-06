import type { MemorySearchHit } from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi, type Mock } from "vitest";

type MemoryProviderTestParams = {
  logger: OpenClawPluginApi["logger"];
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
  lastRuntimeEmbeddedRunParams: () => Record<string, unknown>;
};

function triggerProvider(hits: MemorySearchHit[] = []) {
  return {
    provider: {
      search: vi.fn(async () => ({ hits: [] })),
      capabilities: { candidates: ["trigger"] },
      candidates: vi.fn(async () => ({ hits })),
      close: vi.fn(),
    },
  };
}

/** Registers legacy and provider-neutral Active Memory recall, cache, authority, and tool-selection coverage. */
export function registerActiveMemoryProviderTests(params: MemoryProviderTestParams): void {
  const ownerAudience = { kind: "owner-private", agentId: "main" } as const;
  const ownerContext = {
    sessionKey: "agent:main:telegram:direct:owner",
    sessionId: "owner-session",
    messageProvider: "telegram",
    channelId: "owner",
  };
  function nativeProvider(config: Record<string, unknown>, hits: MemorySearchHit[] = []) {
    params.useNativeProvider();
    params.registerPluginConfig(config);
    const lookup = triggerProvider(hits);
    params.getActiveMemoryProvider.mockResolvedValue(lookup);
    return lookup.provider.search;
  }
  it.each([
    ["group", {}, "not-private-destination"],
    ["direct", { allowedChatIds: ["other"] }, "chat-id-not-allowed"],
    ["direct", { deniedChatIds: ["owner"] }, "chat-id-not-allowed"],
  ])("explains skipped trigger recall for %s (%j)", async (kind, policy, reason) => {
    params.registerPluginConfig({ mode: "off", logging: false, ...policy });
    expect(
      await params.runPromptBuild(
        { prompt: "Help when booking a flight" },
        { ...ownerContext, sessionKey: `agent:main:telegram:${kind}:owner` },
      ),
    ).toBeUndefined();
    const line = `active-memory: lane-1 skipped reason=${reason}`;
    expect(params.logger.debug).toHaveBeenCalledWith(line);
    expect(params.logger.info).not.toHaveBeenCalledWith(line);
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
  });

  it("keeps native and deep recall scoped to the live audience", async () => {
    const search = nativeProvider({ mode: "always", cacheTtlMs: 1_000 }, [
      {
        reference: { providerId: "records", id: "travel" },
        score: 1,
        excerpt: "Prefer aisle seats.",
        citations: [{ label: "Travel preference" }],
        automaticRecall: { eligible: true, triggers: "booking a flight" },
      },
    ]);
    let audienceCurrent = true;
    let recall = 0;
    params.runEmbeddedAgent.mockImplementation(async (run: { sessionFile: string }) => {
      const text =
        ++recall === 1
          ? "stale private memory"
          : recall === 2
            ? "owner-private memory"
            : "conversation memory";
      if (recall === 1) {
        audienceCurrent = false;
      }
      await params.writeUsableMemoryTranscript(run.sessionFile, text);
      return { payloads: [{ text }] };
    });
    const { sessionKey, sessionId } = ownerContext;
    const event = {
      prompt: "what did I order last time?",
      currentUserMessage: "Help when booking a flight",
      currentUserMessageId: "same-request",
    };
    const context = {
      runId: "run-audience-cache",
      ...ownerContext,
      assertMemoryAudienceCurrent: vi.fn(() => {
        if (!audienceCurrent) {
          throw new Error("memory audience is no longer current");
        }
      }),
    };
    params.seedSession(sessionKey, sessionId);

    const owner = {
      ...context,
      memoryAudience: ownerAudience,
    };
    await expect(
      params.runPromptBuild(event, { ...owner, runId: "stale-audience" }),
    ).resolves.toBeUndefined();
    audienceCurrent = true;
    const ownerResult = await params.runPromptBuild(event, owner);
    const conversationAudience = { kind: "conversation", agentId: "main", sessionKey, sessionId };
    const conversationResult = await params.runPromptBuild(event, {
      ...context,
      memoryAudience: conversationAudience,
    });

    params.expectPrependContextContains(ownerResult, "owner-private memory");
    params.expectPrependContextContains(conversationResult, "conversation memory");
    params.expectPrependContextContains(
      ownerResult,
      "Prefer aisle seats. (Source: Travel preference)",
    );
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(params.getActiveMemoryProvider.mock.calls[0]?.[0].context.authority).toEqual({
      kind: "session",
      sessionKey,
      sessionId,
      sandboxed: false,
      audience: ownerAudience,
    });
    expect(context.assertMemoryAudienceCurrent).toHaveBeenCalled();
    expect(params.lastRuntimeEmbeddedRunParams().memoryAudience).toBe(conversationAudience);
    expect(params.getActiveMemoryProvider).toHaveBeenCalledTimes(3);
    expect(search).toHaveBeenCalledTimes(3);
    expect(params.runEmbeddedAgent).toHaveBeenCalledTimes(3);
  });

  it("does not recall historical text for an explicit empty request", async () => {
    const search = nativeProvider({ mode: "always" });
    await params.runPromptBuild({
      prompt: "What do you remember about my preferences?",
      currentUserMessage: " \n ",
      currentUserMessageId: "empty-admission",
      messages: [{ role: "user", content: "What do you remember about my preferences?" }],
    });
    expect(search).not.toHaveBeenCalled();
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("reuses one trigger admission across history changes and keeps authority separate", async () => {
    const search = nativeProvider({ mode: "escalate" });
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

  it.each([
    [["record_find", "record_get"], "recall-tool-not-allowed"],
    [[], "no-recall-tools"],
  ])("explains skipped native trigger recall (%j)", async (tools, reason) => {
    params.memoryCapability.recallToolNames = tools;
    params.useNativeProvider();
    await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        ...ownerContext,
        toolAuthority: {
          fingerprint: "record-find-denied",
          allows: (toolName: string) => toolName !== "record_find",
          assertActive: () => undefined,
        },
      },
    );
    expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
    const line = `active-memory: lane-1 skipped reason=${reason}`;
    expect(params.logger.debug).toHaveBeenCalledWith(line);
    expect(params.logger.info).toHaveBeenCalledWith(line);
  });

  it.each([
    [
      "denies the deterministic recall tool",
      "memory_search",
      "memory_search",
      "recall-tool-not-allowed",
    ],
    ["declares no deterministic recall tool", undefined, undefined, "no-recall-tools"],
  ])("skips legacy trigger recall when the owner %s", async (_label, toolName, denied, reason) => {
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
    const line = `active-memory: lane-1 skipped reason=${reason}`;
    expect(params.logger.debug).toHaveBeenCalledWith(line);
    expect(params.logger.info).toHaveBeenCalledWith(line);
  });
}
