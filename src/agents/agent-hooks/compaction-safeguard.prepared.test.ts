import { afterEach, expect, it, vi } from "vitest";
import { createFileOps } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import type { summarizeCompactionHistory } from "../compaction.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import {
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "./compaction-safeguard-preparation.js";
import type { PreparedCompactionSafeguardFacts } from "./compaction-safeguard-prepared.types.js";
import { consumeCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";
import { executeCompactionSafeguard } from "./compaction-safeguard.js";
import {
  createCompactionEvent,
  createQualityGuardSessionManager,
  runCompactionScenario,
  structuredSummary,
  testing,
  userMessage,
} from "./compaction-safeguard.test-support.js";

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
  resetPluginRuntimeStateForTest();
});

it.each([undefined, "unregistered-provider"])(
  "shares split-turn repair and finalized output without exposing source arrays (provider=%s)",
  async (provider) => {
    const ask = "Finish the migration";
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [userMessage("Start the migration", 1)],
        turnPrefixMessages: [userMessage(ask, 2)],
        isSplitTurn: true,
        requestSelection: { state: "unresolved", request: ask },
        latestUnresolvedUserRequest: ask,
      },
    });
    const history = prepareCompactionSafeguardHistory({
      messages: prepareCompactionSafeguardMessages(event.preparation),
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      readBranch: () => [],
    });
    const summary = prepareCompactionSafeguardSummary({
      history,
      preparation: event.preparation,
      recentTurnsPreserve: 0,
      splitTurnContextChars: 8000,
      qualityGuardEnabled: true,
    });
    const facts: PreparedCompactionSafeguardFacts = {
      previousSummary: history.previousSummary,
      history: {
        hasRealConversation: history.hasRealConversation,
        usedPreparationRange: history.usedPreparationRange,
      },
      sections: prepareCompactionSafeguardSections({ fileOps: createFileOps(), history }),
      summary: {
        latestUserAsk: summary.latestUserAsk,
        latestAskInRetainedTurn: summary.latestAskInRetainedTurn,
        identifiers: summary.identifiers,
        requiredAskContext: summary.requiredAskContext,
        preservedTurnsSection: summary.preservedTurnsSection,
      },
      reconciliationCount: summary.reconciliationMessages.length,
      turnPrefixCount: history.turnPrefixMessages.length,
    };
    const responses = [
      "incomplete",
      structuredSummary({ asks: ask }),
      structuredSummary({ asks: ask }),
      structuredSummary({ asks: ask }),
    ];
    const eager = vi.fn<typeof summarizeCompactionHistory>();
    responses.forEach((response) => eager.mockResolvedValueOnce(response));
    testing.setSummarizeCompactionHistoryForTest(eager);
    const arrayResult = await runCompactionScenario(
      createQualityGuardSessionManager({ provider }),
      event,
    );
    const sources: string[] = [];
    const lazy = vi.fn(
      async (
        source: "history" | "turnPrefix",
        params: Omit<Parameters<typeof summarizeCompactionHistory>[0], "messages">,
      ) => {
        expect(params).not.toHaveProperty("messages");
        sources.push(source);
        return responses[sources.length - 1]!;
      },
    );
    const {
      messagesToSummarize: _history,
      turnPrefixMessages: _prefix,
      ...metadata
    } = event.preparation;
    const preparedResult = await executeCompactionSafeguard(
      {
        ...event,
        type: "session_before_compact",
        preparation: {
          ...metadata,
          settings: { ...metadata.settings, enabled: true, keepRecentTokens: 20_000 },
          fileOps: createFileOps(),
        },
      },
      {
        identity: createQualityGuardSessionManager({ provider }),
        model: undefined,
        modelRegistry: ModelRegistry.inMemory(
          AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } }),
        ),
      },
      { facts, summarize: lazy },
    );
    expect(preparedResult).toEqual(arrayResult.result);
    expect(sources).toEqual(["history", "turnPrefix", "history", "turnPrefix"]);
    expect(eager).toHaveBeenCalledTimes(4);
  },
);

it("rejects registered custom providers in prepared execution before summarizing", async () => {
  const provider = "registered-provider";
  const providerSummarize = vi.fn().mockResolvedValue("provider summary");
  requireActivePluginRegistry().compactionProviders.push({
    provider: { id: provider, label: provider, summarize: providerSummarize },
  });
  const identity = createQualityGuardSessionManager({ provider });
  const summarize = vi.fn().mockResolvedValue("LLM summary");
  const event = createCompactionEvent();
  const history = prepareCompactionSafeguardHistory({
    messages: prepareCompactionSafeguardMessages(event.preparation),
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    readBranch: () => [],
  });
  const summary = prepareCompactionSafeguardSummary({
    history,
    preparation: event.preparation,
    recentTurnsPreserve: 0,
    splitTurnContextChars: 8000,
    qualityGuardEnabled: true,
  });
  const {
    messagesToSummarize: _history,
    turnPrefixMessages: _prefix,
    ...preparation
  } = event.preparation;
  const result = await executeCompactionSafeguard(
    {
      ...event,
      type: "session_before_compact",
      preparation: {
        ...preparation,
        settings: { ...preparation.settings, enabled: true, keepRecentTokens: 20_000 },
        fileOps: createFileOps(),
      },
    },
    {
      identity,
      model: undefined,
      modelRegistry: ModelRegistry.inMemory(
        AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } }),
      ),
    },
    {
      facts: {
        previousSummary: history.previousSummary,
        history,
        sections: prepareCompactionSafeguardSections({ fileOps: createFileOps(), history }),
        summary,
        reconciliationCount: summary.reconciliationMessages.length,
        turnPrefixCount: history.turnPrefixMessages.length,
      },
      summarize,
    },
  );
  expect(result).toEqual({ cancel: true });
  expect(consumeCompactionSafeguardCancellation(identity)?.reason).toContain(
    "Prepared compaction does not support custom compaction providers",
  );
  expect(providerSummarize).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
});
