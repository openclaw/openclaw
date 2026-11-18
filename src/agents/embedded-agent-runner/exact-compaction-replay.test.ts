import { describe, expect, it } from "vitest";
import { buildProviderReplayContext } from "../../../packages/ai/src/transports/provider-replay-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import {
  collectExactReplayMediaFacts,
  collectExactReplaySourceFact,
  resolveExactReplaySourcePolicy,
  compareExactReplayRows,
  prepareExactCompactionReplay,
  type ExactReplayContext,
} from "./exact-compaction-replay.js";
import { prepareCompactionReplay } from "./prepared-compaction-replay.js";
import type { PreparedCompactionReplayOptions } from "./replay-history.types.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const user = (content: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content,
  timestamp,
});
const assistant = (
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
  stopReason: "stop" | "error" | "toolUse" = "stop",
): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content,
  timestamp: 1,
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const call = (id = "call_one") => ({
  type: "toolCall" as const,
  id,
  name: "read",
  arguments: { path: "fixture" },
});
const result = (id = "call_one"): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [text("done")],
  timestamp: 2,
  isError: false,
});
function options(): PreparedCompactionReplayOptions {
  return {
    model: makeProviderModelFixture({
      id: "fixture",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
    }),
    policy: {
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: false,
      repairToolUseResultPairing: true,
      preserveSignatures: false,
      dropThinkingBlocks: false,
      applyGoogleTurnOrdering: false,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    },
    imageLimits: {},
    allowedToolNames: ["read"],
    signedThinkingProvider: false,
    allowProviderOwnedThinkingReplay: false,
    isOpenAIResponsesApi: false,
    sessionId: "exact-replay",
    replayEnabled: true,
  };
}
const context: ExactReplayContext = { builtinGoogleReplay: false, googleMarkerPresent: false };
async function replay(messages: AgentMessage[], config = options(), route = context) {
  let mediaReads = 0;
  let comparisonReads = 0;
  const preflight = structuredClone(
    messages.map((message, index) => collectExactReplaySourceFact(message, index)),
  );
  const facts = preflight.map((fact) =>
    fact.deferredCheckpoint
      ? collectExactReplaySourceFact(messages[fact.source]!, fact.source, config)
      : resolveExactReplaySourcePolicy(fact, config),
  );
  const value = await prepareExactCompactionReplay(structuredClone(facts), config, route, {
    readMedia: async (source, indexes) => {
      mediaReads++;
      return collectExactReplayMediaFacts(messages[source]!, source, indexes, config);
    },
    compareRows: (request) =>
      compareExactReplayRows(request, async (source) => {
        comparisonReads++;
        return messages[source]!;
      }),
  });
  return { ...value, mediaReads, comparisonReads, facts };
}

describe("exact detached compaction replay", () => {
  it("selects exact signature policy after route-independent Gateway preflight", () => {
    const signedText = {
      type: "text" as const,
      text: "result",
      thought_signature: "c2lnbmVk",
      thoughtSignature: "invalid",
    };
    const message = assistant([
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "signed" },
      { type: "text", text: " ", textSignature: "signed" },
      signedText,
    ]);
    const preflight = structuredClone(collectExactReplaySourceFact(message, 0));
    for (const preserveSignatures of [true, false]) {
      for (const allowBase64Only of [true, false]) {
        for (const includeCamelCase of [true, false]) {
          const config = options();
          config.policy = {
            ...config.policy,
            preserveSignatures,
            sanitizeThoughtSignatures: { allowBase64Only, includeCamelCase },
          };
          expect(resolveExactReplaySourcePolicy(preflight, config)).toEqual(
            collectExactReplaySourceFact(message, 0, config),
          );
        }
      }
    }
  });
  it("rounds after merging and preserves completed failed calls", async () => {
    const merged = await replay([assistant([text("a")]), assistant([text("b")])]);
    expect(merged.beforeHookMetrics).toEqual({
      messageCountOriginal: 1,
      tokenCountOriginal: 1,
      messageCountBefore: 1,
      tokenCountBefore: 1,
    });
    expect(merged.hasRealConversation).toBe(true);
    const completed = await replay([assistant([call()], "error"), result()]);
    expect(completed.beforeHookMetrics.messageCountOriginal).toBe(2);
    expect(completed.hasRealConversation).toBe(false);
    expect(completed.mediaReads + completed.comparisonReads).toBe(0);
  });

  it("excludes source text, arguments, signatures, and image bytes from facts", () => {
    const body = "private-large-body-".repeat(30_000);
    const message = assistant([
      text(body),
      { ...call(), arguments: { body } },
      { type: "thinking", thinking: body, thinkingSignature: body },
    ]);
    const fact = collectExactReplaySourceFact(message, 0, options());
    expect(JSON.stringify(fact)).not.toContain("private-large-body");
    expect(JSON.stringify(fact).length).toBeLessThan(10_000);
  });

  it("sanitizes only selected media rows after collection", async () => {
    const image: AgentMessage = {
      role: "user",
      content: [{ type: "image", data: "invalid-base64", mimeType: "image/png" }],
      timestamp: 1,
    };
    const actual = await replay([user("old"), image, assistant([text("done")])]);
    const expected = await prepareCompactionReplay([], options(), [
      user("old"),
      image,
      assistant([text("done")]),
    ]);
    expect(actual.beforeHookMetrics).toEqual(expected.beforeHookMetrics);
    expect(actual.mediaReads).toBe(1);
    expect(actual.comparisonReads).toBe(0);
    expect(JSON.stringify(actual.facts)).not.toContain("invalid-base64");
  });

  it("uses fingerprints only to select exact rereads", async () => {
    const config = options();
    config.policy.validateAnthropicTurns = false;
    const messages = [
      user("first question repeated across retry"),
      user("other question repeated across retry"),
    ];
    const facts = messages.map((message, index) =>
      collectExactReplaySourceFact(message, index, config),
    );
    const left = facts[0]!.normalized!.stringContent!;
    facts[1]!.normalized!.stringContent!.duplicateText = left.duplicateText;
    let reads = 0;
    const value = await prepareExactCompactionReplay(facts, config, context, {
      readMedia: async () => {
        throw new Error("No media expected");
      },
      compareRows: (request) =>
        compareExactReplayRows(request, async (source) => {
          reads++;
          return messages[source]!;
        }),
    });
    expect(value.beforeHookMetrics.messageCountOriginal).toBe(2);
    expect(reads).toBe(2);
    const duplicate = await replay([messages[0]!, messages[0]!], config);
    expect(duplicate.beforeHookMetrics.messageCountOriginal).toBe(1);
    expect(duplicate.comparisonReads).toBe(2);
  });

  it("preserves reset preludes through structured-clone fact transport", async () => {
    const config = options();
    config.historyLimit = 1;
    config.policy.validateAnthropicTurns = false;
    const prelude = Object.assign(user("retained reset prelude"), {
      [Symbol.for("openclaw.sessionHistoryPrelude")]: true,
    });
    const messages = [
      prelude,
      user("one"),
      assistant([text("answer")]),
      user("two"),
      assistant([text("answer")]),
      user("three"),
    ];
    const actual = await replay(messages, config);
    const expected = await prepareCompactionReplay([], config, messages);
    expect(actual.beforeHookMetrics).toEqual(expected.beforeHookMetrics);
    expect(actual.beforeHookMetrics.messageCountBefore).toBe(2);
  });

  it("computes Google marker eligibility after cleanup, only for the builtin callback", async () => {
    const config = options();
    config.policy.applyGoogleTurnOrdering = true;
    const messages = [user(" "), assistant([text("answer")])];
    const builtin = await replay(messages, config, { ...context, builtinGoogleReplay: true });
    expect(builtin.needsGoogleTurnOrderingMarker).toBe(true);
    expect(builtin.beforeHookMetrics.messageCountOriginal).toBe(2);
    expect((await replay(messages, config)).needsGoogleTurnOrderingMarker).toBe(false);
    expect(
      (await replay(messages, config, { builtinGoogleReplay: true, googleMarkerPresent: true }))
        .needsGoogleTurnOrderingMarker,
    ).toBe(false);
    expect(
      (
        await replay([assistant([text("NO_REPLY")]), user("question")], config, {
          ...context,
          builtinGoogleReplay: true,
        })
      ).needsGoogleTurnOrderingMarker,
    ).toBe(false);
  });

  it("carries a Responses checkpoint without re-running a no-op content replacement", async () => {
    const config = options();
    config.model = makeProviderModelFixture({
      id: "fixture",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
    });
    config.isOpenAIResponsesApi = true;
    config.historyLimit = 1;
    Object.assign(config.policy, {
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      dropReasoningFromHistory: true,
      dropThinkingBlocks: true,
    });
    const owner = assistant([
      {
        type: "thinking",
        thinking: "old",
        thinkingSignature: '{"id":"rs_old","type":"reasoning"}',
      },
      text("owner"),
    ]);
    owner.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: "encrypted-checkpoint-secret",
      replayIndex: 2,
      ...buildProviderReplayContext(config.model, { sessionId: config.sessionId }),
    };
    const messages: AgentMessage[] = [
      { role: "compactionSummary", summary: "summary", timestamp: 0, tokensBefore: 0 },
      owner,
      ...Array.from({ length: 7 }, (_, index) => user(`question ${index}`)),
    ];
    const actual = await replay(messages, config, { ...context, latestModelSwitchTimestamp: 3 });
    expect(actual.beforeHookMetrics).toEqual({
      messageCountOriginal: 9,
      tokenCountOriginal: 25,
      messageCountBefore: 2,
      tokenCountBefore: 3,
    });
    expect(JSON.stringify(actual.facts)).not.toContain("encrypted-checkpoint-secret");
  });

  it("matches the array adapter across deterministic mixed histories", async () => {
    const templates = [
      user("question ".repeat(5)),
      assistant([text("a")]),
      assistant([text("b")]),
      assistant([text("NO_REPLY")]),
      assistant([call()], "error"),
      result(),
      assistant([{ type: "thinking" as const, thinking: "unsigned" }]),
    ];
    let seed = 0x195361;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let index = 0; index < 100; index++) {
      const messages = Array.from({ length: random(12) }, () =>
        structuredClone(templates[random(templates.length)]!),
      );
      const config = options();
      config.historyLimit = index % 3 === 0 ? 1 : undefined;
      config.policy.dropThinkingBlocks = index % 2 === 0;
      const expected = await prepareCompactionReplay([], config, messages);
      const actual = await replay(messages, config);
      expect(actual.beforeHookMetrics).toEqual(expected.beforeHookMetrics);
      expect(actual.hasRealConversation).toBe(expected.hasRealConversation);
    }
  });
});
