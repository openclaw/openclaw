// Coverage for prompt-cache diagnostic tracking across turns.
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import * as cryptoDigest from "@openclaw/normalization-core/node-crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import type { Message, TextContent } from "../../llm/types.js";
import { withEnv } from "../../test-utils/env.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { log } from "./logger.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  declarePromptHistoryRewrite,
  recordAggregateTruncation,
} from "./prompt-cache-observability.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";

let testScope = 0;
let currentTestScope = "";

function scopedKey(value: string): string {
  return `${value}:${currentTestScope}`;
}

type ObservationParams = Parameters<typeof beginPromptCacheObservation>[0];

function beginOpenAIObservation(
  params: Pick<ObservationParams, "sessionId"> & Partial<ObservationParams>,
) {
  return beginPromptCacheObservation({
    messages: [],
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    streamStrategy: "boundary-aware:openai-responses",
    systemPrompt: "stable system",
    tools: [{ name: "read" }],
    ...params,
  });
}

describe("prompt cache observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps concurrent review and foreground usage in their own diagnostic sessions", () => {
    const promptCacheKey = scopedKey("shared-provider-affinity");
    const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
    const context = { systemPrompt: "stable", messages: [] };
    const foregroundResult = vi.fn();
    const reviewResult = vi.fn();
    const foreground = createPromptCacheRequestObserver(
      { sessionId: scopedKey("foreground"), promptCacheKey, streamStrategy: "test" },
      foregroundResult,
    );
    const review = createPromptCacheRequestObserver(
      { sessionId: scopedKey("review"), promptCacheKey, streamStrategy: "test" },
      reviewResult,
    );
    review.onModelRequest(model, context);
    foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 9_000 });
    review.onModelUsage({ cacheRead: 0, input: 1_000 });
    expect(review.getObservation()).toMatchObject({ broke: false });
    foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 2_000 });
    expect(foreground.getObservation()).toMatchObject({
      broke: true,
      previousCacheRead: 9_000,
      cacheRead: 2_000,
    });
  });

  it.each([
    ["system", { instructions: "provider rewritten system" }],
    ["tools", { tools: [{ type: "function", name: "changed" }] }],
    ["message:0", { input: [{ role: "user", content: "provider rewritten history" }] }],
    ["parameters", { reasoning: { effort: "high" } }],
    [
      "prefix-match",
      {
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "appended" },
        ],
      },
    ],
  ] as const)(
    "identifies final encoded %s changes despite unchanged assembled context",
    (expected, replacement) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const observer = createPromptCacheRequestObserver(
        { sessionId: scopedKey(`wire-${expected}`), streamStrategy: "test" },
        () => {},
      );
      const payload = {
        instructions: "original system",
        tools: [{ type: "function", name: "read" }],
        input: [{ role: "user", content: "first" }],
        reasoning: { effort: "low" },
      };
      const request = (body: unknown, cacheRead: number) => {
        observer.onModelRequest(
          { provider: "openai", id: "test-model", api: "openai-responses" },
          { systemPrompt: "original system", messages: [] },
        );
        const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
          payload: body,
          encode: true,
        });
        observer.onModelUsage(
          {
            cacheRead,
            contextUsage: { state: "available", promptTokens: 10_000, totalTokens: 10_100 },
          },
          { scopeDigest: "same-provider-scope", ...fingerprint },
        );
      };
      request(payload, 9_000);
      clock.mockReturnValue(3_000);
      request({ ...payload, ...replacement }, 2_000);
      expect(observer.getObservation()).toMatchObject({
        broke: true,
        changes: null,
        providerPrefix: expected,
        requestGapMs: 2_000,
        promptTokens: 10_000,
      });
    },
  );

  it("does not claim a bounded message tail matched when the history grows", () => {
    const identity = { sessionId: scopedKey("bounded-wire-tail") };
    const message = { role: "user", content: "synthetic history" };
    const input = Array.from({ length: 513 }, () => message);
    const complete = (cacheRead: number) => {
      beginOpenAIObservation(identity);
      const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
        payload: { input },
        encode: true,
      });
      return completePromptCacheObservation({
        ...identity,
        usage: { cacheRead },
        providerPrompt: { scopeDigest: "same-provider-scope", ...fingerprint },
      });
    };
    complete(9_000);
    input.push(message);
    expect(complete(6_000)?.providerPrefix).toBe("unverified-after:512");
    input[513] = { ...message, content: "changed tail" };
    expect(complete(3_000)?.providerPrefix).toBe("message-tail:512");
  });

  it("keeps a two-turn tool loop append-only with bounded block hashing", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("two-turn-loop");
      const source: AgentMessage[] = [
        { role: "user", content: [{ type: "text", text: "Read the fixture" }], timestamp: 1 },
        {
          role: "custom",
          customType: "fixture-context",
          content: [{ type: "text", text: "Fixture context" }],
          display: false,
          timestamp: 2,
        },
      ];
      const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
      const observed = vi.fn();
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        observed,
      );
      const request = () => {
        const messages = convertToLlm(source);
        observer.onModelRequest(
          { provider: "openai", id: "test-model", api: "openai-responses" },
          { messages },
        );
        observer.onModelUsage({ cacheRead: 8_000 });
        return messages;
      };
      const first = request();
      source.push(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 3,
        }),
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "fixture result" }],
          isError: false,
          timestamp: 4,
        },
      );
      const loop = request();
      source.push(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Read complete" }],
          timestamp: 5,
        }),
        { role: "user", content: "Summarize it", timestamp: 6 },
      );
      request();
      expect(loop[0]).toBe(first[0]);
      expect(loop[1]).not.toBe(first[1]);
      expect(loop[1]?.content).toBe(first[1]?.content);
      for (const text of ["Read the fixture", "Fixture context", "fixture result"]) {
        expect(
          hashes.mock.calls.filter(([value]) => typeof value === "string" && value.includes(text)),
        ).toHaveLength(1);
      }
      expect(observed).toHaveBeenCalledTimes(3);
      for (const [observation] of observed.mock.calls) {
        expect(observation.changes).toBeNull();
      }
    });
  });

  it.each([
    ["block", false],
    ["block", true],
    ["string", false],
    ["string", true],
  ] as const)("detects mutated %s text (rebuilt wrapper=%s)", (kind, rebuildWrapper) => {
    const sessionId = scopedKey(`mutated-${kind}`);
    const block: TextContent = { type: "text", text: "original" };
    const first: Message = { role: "user", content: "question", timestamp: 1 };
    const message: Message =
      kind === "string"
        ? { role: "user", content: "original", timestamp: 2 }
        : makeAgentAssistantMessage({ content: [block], timestamp: 2 });
    beginOpenAIObservation({ sessionId, messages: [first, message] });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
    if (message.role === "user") {
      message.content = "rewritten";
    } else {
      block.text = "rewritten";
    }
    const detail = `message 1 (${message.role}) differs from the previous request; history must be append-only; changed fields: ${kind === "string" ? "content" : "content[0]"}`;
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      expect(() =>
        beginOpenAIObservation({
          sessionId,
          messages: [first, rebuildWrapper ? { ...message } : message],
        }),
      ).toThrow(detail);
    });
    expect(
      completePromptCacheObservation({ sessionId, usage: { input: 8_000, cacheRead: 0 } })?.changes,
    ).toEqual([{ code: "historyRewrite", detail }]);
  });

  it("detects nested tool arguments mutated in place", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("mutated-arguments");
      const args = { options: { path: "before" } };
      const message = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: args }],
      });
      beginOpenAIObservation({ sessionId, messages: [message] });
      args.options.path = "after";
      expect(() => beginOpenAIObservation({ sessionId, messages: [message] })).toThrow(
        "message 0 (assistant)",
      );
    });
  });

  it("detects primitive property additions, changes, and removals", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("mutated-properties");
      const block: TextContent = { type: "text", text: "stable" };
      const message = makeAgentAssistantMessage({ content: [block] });
      beginOpenAIObservation({ sessionId, messages: [message] });
      for (const mutate of [
        () => {
          block.textSignature = undefined;
        },
        () => {
          block.textSignature = "signature";
        },
        () => {
          delete block.textSignature;
        },
      ]) {
        mutate();
        expect(() => beginOpenAIObservation({ sessionId, messages: [message] })).toThrow(
          "message 0 (assistant)",
        );
      }
    });
  });

  it.each(["block", "string"] as const)(
    "hashes unchanged large %s content once across three observations",
    (kind) => {
      const sessionId = scopedKey(`large-${kind}`);
      const text = "large-content-fixture ".repeat(50_000);
      const message: Message = {
        role: "user",
        content: kind === "string" ? text : [{ type: "text", text }],
        timestamp: 1,
      };
      const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
      for (let index = 0; index < 3; index++) {
        expect(
          beginOpenAIObservation({ sessionId, messages: [{ ...message }] }).changes,
        ).toBeNull();
      }
      expect(
        hashes.mock.calls.filter(
          ([value]) => typeof value === "string" && value.includes("large-content-fixture"),
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["edit", "remove", "reorder"] as const)(
    "reports the first history divergence after %s",
    (kind) => {
      const first: Message = { role: "user", content: "first", timestamp: 1 };
      const second = makeAgentAssistantMessage({
        content: [{ type: "text", text: "second" }],
        timestamp: 2,
      });
      const messages = [first, second];
      const changed =
        kind === "edit"
          ? [first, { ...second, content: [{ type: "text" as const, text: "rewritten" }] }]
          : kind === "remove"
            ? [first]
            : [second, first];
      const index = kind === "reorder" ? 0 : 1;
      const fields =
        kind === "remove"
          ? "message removed"
          : kind === "edit"
            ? "changed fields: content[0]"
            : "changed fields: content.type, content, envelope.role, envelope.timestamp, envelope.api, envelope.provider, envelope.model, envelope.usage, …";
      const detail = `message ${index} (assistant) differs from the previous request; history must be append-only; ${fields}`;
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const sessionId = scopedKey(kind);
      beginOpenAIObservation({ sessionId, messages });
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: undefined }, () => {
        expect(beginOpenAIObservation({ sessionId, messages: changed }).changes).toEqual([
          { code: "historyRewrite", detail },
        ]);
        expect(
          completePromptCacheObservation({ sessionId, usage: { input: 8_000, cacheRead: 0 } })
            ?.changes,
        ).toEqual([{ code: "historyRewrite", detail }]);
        beginOpenAIObservation({ sessionId, messages });
        expect(warn).toHaveBeenCalledTimes(1);
      });
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        expect(() => beginOpenAIObservation({ sessionId, messages: changed })).toThrow(detail);
      });
    },
  );

  it.each([
    { field: "timestamp", value: 2, label: "timestamp" },
    { field: "idempotencyKey", value: "private-value", label: "idempotencyKey" },
    { field: "__openclaw", value: { senderName: "private-value" }, label: "__openclaw" },
    { field: "usage", value: { input: 42 }, label: "usage" },
    { field: "private-field-name", value: "private-value", label: "other" },
  ])(
    "identifies changed $label metadata without logging values or extension keys",
    ({ field, value, label }) => {
      const sessionId = scopedKey(`metadata-${label}`);
      const message: Message & Record<string, unknown> = {
        role: "user",
        content: "private-prompt",
        timestamp: 1,
      };
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      beginOpenAIObservation({ sessionId, messages: [message] });
      message[field] = value;
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: undefined }, () => {
        expect(beginOpenAIObservation({ sessionId, messages: [message] }).changes).toEqual([
          {
            code: "historyRewrite",
            detail: `message 0 (user) differs from the previous request; history must be append-only; changed fields: envelope.${label}`,
          },
        ]);
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`changed fields: envelope.${label} sessionKey=`),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
    },
  );

  it("bounds content diagnostics while detecting changes beyond the retained block prefix", () => {
    const sessionId = scopedKey("bounded-content-diff");
    const blocks: TextContent[] = Array.from({ length: 20 }, () => ({
      type: "text",
      text: "before",
    }));
    const message = makeAgentAssistantMessage({ content: blocks });
    beginOpenAIObservation({ sessionId, messages: [message] });
    blocks[19]!.text = "private-rewritten-content";
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      expect(() => beginOpenAIObservation({ sessionId, messages: [message] })).toThrow(
        "changed fields: content[remaining]",
      );
      for (const block of blocks) {
        block.text = "private-second-rewrite";
      }
      expect(() => beginOpenAIObservation({ sessionId, messages: [message] })).toThrow(
        "changed fields: content[0], content[1], content[2], content[3], content[4], content[5], content[6], content[7], …",
      );
    });
  });

  it.each(["compaction", "pruning", "runtimeContextCarrier", "imageCleanup"] as const)(
    "consumes a declared %s rewrite for exactly one request",
    (reason) => {
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        const sessionId = scopedKey(reason);
        const messages: Message[] = [{ role: "user", content: "before", timestamp: 1 }];
        beginOpenAIObservation({ sessionId, messages });
        declarePromptHistoryRewrite({ sessionId, reason });
        const rewritten: Message[] = [{ role: "user", content: "after", timestamp: 1 }];
        expect(beginOpenAIObservation({ sessionId, messages: rewritten }).changes).toEqual([
          { code: reason, detail: `${reason} changed provider history` },
        ]);
        expect(beginOpenAIObservation({ sessionId, messages: rewritten }).changes).toBeNull();
        expect(() => beginOpenAIObservation({ sessionId, messages })).toThrow("message 0 (user)");
      });
    },
  );

  it.each(["compaction", "pruning", "runtimeContextCarrier", "imageCleanup"] as const)(
    "shares a %s declaration across cache affinities only within the same session key",
    (reason) => {
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        const identity = { sessionId: scopedKey("affinities"), sessionKey: scopedKey("primary") };
        const before: Message[] = [{ role: "user", content: "before", timestamp: 1 }];
        const after: Message[] = [{ role: "user", content: "after", timestamp: 1 }];
        const keys = [scopedKey("affinity-a"), scopedKey("affinity-b")];
        for (const promptCacheKey of keys) {
          beginOpenAIObservation({ ...identity, promptCacheKey, messages: before });
        }
        const unrelated = {
          ...identity,
          sessionKey: scopedKey("other"),
          promptCacheKey: scopedKey("unrelated-affinity"),
        };
        beginOpenAIObservation({ ...unrelated, messages: before });
        declarePromptHistoryRewrite({ ...identity, promptCacheKey: keys[0], reason });
        for (const promptCacheKey of keys) {
          expect(
            beginOpenAIObservation({ ...identity, promptCacheKey, messages: after }).changes,
          ).toEqual([{ code: reason, detail: `${reason} changed provider history` }]);
          expect(
            beginOpenAIObservation({ ...identity, promptCacheKey, messages: after }).changes,
          ).toBeNull();
        }
        expect(() => beginOpenAIObservation({ ...unrelated, messages: after })).toThrow(
          "message 0 (user)",
        );
      });
    },
  );

  it.each([
    { modelId: "other" },
    { transport: "websocket" },
    { cacheRetention: "long" as const },
    { sessionId: "new-session" },
  ])("restarts the history series for %j", (change) => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const identity = { sessionId: scopedKey("series"), promptCacheKey: scopedKey("affinity") };
      beginOpenAIObservation({
        ...identity,
        messages: [{ role: "user", content: "previous", timestamp: 1 }],
      });
      expect(() => beginOpenAIObservation({ ...identity, ...change, messages: [] })).not.toThrow();
    });
  });

  it("does not reuse a content digest for a different tool-call identity", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("shared-content");
      const result: Message = {
        role: "toolResult",
        toolName: "read",
        toolCallId: "first",
        content: [],
        isError: false,
        timestamp: 1,
      };
      beginOpenAIObservation({ sessionId, messages: [result] });
      expect(() =>
        beginOpenAIObservation({ sessionId, messages: [{ ...result, toolCallId: "second" }] }),
      ).toThrow("message 0 (toolResult)");
    });
  });

  beforeEach(() => {
    currentTestScope = String(++testScope);
  });

  it.each([
    {
      name: "three healthy calls then one",
      turns: [[10_000, 10_000, 10_000], [10_000]],
      misses: [],
    },
    {
      name: "one call then a miss and two hits",
      turns: [[10_000], [0, 10_000, 10_000]],
      misses: ["2:1"],
    },
    { name: "a complete miss below the drop threshold", turns: [[500], [0]], misses: ["2:1"] },
  ])("observes each request: $name", ({ turns, misses }) => {
    const sessionId = scopedKey("request-usage");
    const observed: Array<{ request: string; cacheRead: number | undefined; broke: boolean }> = [];
    for (const [turnIndex, reads] of turns.entries()) {
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        (observation) =>
          observed.push({
            request: `${turnIndex + 1}:${observation.requestIndex}`,
            cacheRead: observation.cacheRead,
            broke: observation.broke,
          }),
      );
      for (const cacheRead of reads) {
        observer.onModelRequest(
          { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
          {
            messages: [],
            systemPrompt: "stable prefix",
            tools: [{ name: "read", description: "Read text", parameters: Type.Object({}) }],
          },
        );
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
      }
    }
    expect(observed.map((entry) => entry.cacheRead)).toEqual(turns.flat());
    expect(observed.filter((entry) => entry.broke).map((entry) => entry.request)).toEqual(misses);
  });

  it.each([false, true])(
    "keeps small complete misses tied to the last reported fingerprint (changed=%s)",
    (changed) => {
      const sessionId = scopedKey("small-cache-miss");
      const begin = (systemPrompt: string) =>
        beginPromptCacheObservation({
          messages: [],
          sessionId,
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          streamStrategy: "test",
          systemPrompt,
          tools: [],
        });
      begin("prefix A");
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 500 } });
      if (changed) {
        begin("prefix B");
        completePromptCacheObservation({ sessionId });
      }
      recordAggregateTruncation({ sessionId });
      begin(changed ? "prefix B" : "prefix A");
      const result = completePromptCacheObservation({
        sessionId,
        usage: { input: 500, cacheRead: 0 },
      });
      if (changed) {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({
          previousCacheRead: 500,
          cacheRead: 0,
          changes: [{ code: "aggregateToolResultTruncation" }],
        });
      }
    },
  );

  it("collects canonical trimmed tool snapshots", () => {
    expect(
      collectPromptCacheTools([{ name: "write" }, { name: "" }, {}, { name: " read " }]),
    ).toEqual([{ name: "read" }, { name: "write" }]);
  });

  it("collects prompt-cache tools without aborting on unreadable descriptors", () => {
    const unreadableTool = {
      get name(): string {
        throw new Error("tool name getter exploded");
      },
    };

    expect(
      collectPromptCacheTools([{ name: " read " }, unreadableTool, { name: "write" }]),
    ).toEqual([{ name: "read" }, { name: "write" }]);
  });

  it("fingerprints tool descriptions and schemas without retaining their content", () => {
    const first = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a text file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const changedDescription = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const changedSchema = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a text file",
        parameters: { type: "object", properties: { path: { type: "number" } } },
      },
    ]);

    expect(first[0]).toEqual({
      name: "read",
      descriptionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first[0]?.descriptionDigest).not.toBe(changedDescription[0]?.descriptionDigest);
    expect(first[0]?.schemaDigest).not.toBe(changedSchema[0]?.schemaDigest);
  });

  it("fingerprints own __proto__ schema properties without prototype pollution", () => {
    const collectSchema = (properties: Record<string, unknown>) =>
      collectPromptCacheTools([
        {
          name: "read",
          parameters: { type: "object", properties },
        },
      ]);
    const stringPrototype = collectSchema({
      ["__proto__"]: { type: "string" },
    });
    const numberPrototype = collectSchema({
      ["__proto__"]: { type: "number" },
    });
    const noPrototype = collectSchema({});

    expect(stringPrototype[0]?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stringPrototype[0]?.schemaDigest).not.toBe(numberPrototype[0]?.schemaDigest);
    expect(stringPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
    expect(numberPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
  });

  it("memoizes cycle-safe schemas and skips unreadable tools", () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.self = parameters;
    const digest = vi.spyOn(cryptoDigest, "sha256Hex");
    const unreadable = {
      name: "unreadable",
      get parameters(): object {
        throw new Error("unreadable schema");
      },
    };
    const first = collectPromptCacheTools([{ name: "read", parameters }, unreadable]);
    expect(first).toEqual([
      { name: "read", schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(collectPromptCacheTools([{ name: "read", parameters }])).toEqual(first);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("fingerprints complete schemas independently of property insertion order", () => {
    const collect = (parameters: object) => collectPromptCacheTools([{ name: "read", parameters }]);
    expect(collect({ type: "object", properties: { a: {}, b: {} } })).toEqual(
      collect({ properties: { b: {}, a: {} }, type: "object" }),
    );
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    // Observability only emits when a material cache-read drop follows a tracked
    // cache-affecting change.
    const first = beginOpenAIObservation({
      sessionId: "session-1",
      sessionKey: scopedKey("agent:main"),
      cacheRetention: "long",
      transport: "sse",
      tools: [{ name: "read" }, { name: "write" }],
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 8_000 },
      }),
    ).toBeNull();

    const second = beginOpenAIObservation({
      sessionId: "session-1",
      sessionKey: scopedKey("agent:main"),
      cacheRetention: "short",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }, { name: "write" }],
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      messages: [],
      sessionId: scopedKey("session-1"),
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      usage: { cacheRead: 5_000 },
    });

    beginPromptCacheObservation({
      messages: [],
      sessionId: scopedKey("session-1"),
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        usage: { cacheRead: 4_600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    // Tool list ordering is deterministic for payloads but should not create a
    // false cache-break diagnostic when the set is unchanged.
    beginOpenAIObservation({
      sessionId: scopedKey("session-1"),
      tools: [{ name: "read" }, { name: "write" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      usage: { cacheRead: 8_000 },
    });

    const second = beginOpenAIObservation({
      sessionId: scopedKey("session-1"),
      tools: [{ name: "write" }, { name: "read" }],
    });

    expect(second.changes).toBeNull();
  });

  it.each([
    ["## Skills", "Skills", "prefix"],
    ["# Project Context\n## MEMORY.md\n## Skills", "Project Context", "prefix"],
    ["## Runtime", "Runtime", "suffix"],
    ["## Temporal Context", "Temporal Context", "suffix"],
    ["## private-plugin-heading", "Other", "suffix"],
  ] as const)("attributes changed %s content in the %s section (%s)", (heading, section, side) => {
    const sessionId = scopedKey("changed-prompt-section");
    const prompt = (content: string) => {
      const changed = `${heading}\n${content}\n`;
      return side === "prefix"
        ? `${changed}${SYSTEM_PROMPT_CACHE_BOUNDARY}stable suffix`
        : `stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}${changed}`;
    };
    beginOpenAIObservation({ sessionId, systemPrompt: prompt("private-content-before") });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
    beginOpenAIObservation({ sessionId, systemPrompt: prompt("private-content-after") });

    expect(
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 2_000 } })?.changes,
    ).toEqual([
      {
        code: side === "prefix" ? "systemPrompt" : "systemPromptSuffix",
        detail: `system prompt${side === "suffix" ? " suffix" : ""} digest changed (sections: ${section})`,
      },
    ]);
  });

  it("bounds section metadata and excludes arbitrary headings and contents", () => {
    const sessionId = scopedKey("bounded-prompt-sections");
    const unknown = Array.from(
      { length: 100 },
      (_, index) => `## private-heading-${index}\nprivate-content-${index}`,
    ).join("\n");
    const first = beginOpenAIObservation({
      sessionId,
      systemPrompt: `${unknown}\n## Skills\nprivate-skill\n`,
    });
    expect(first.snapshot.systemPromptSections).toEqual({
      Other: expect.stringMatching(/^[a-f0-9]{64}$/),
      Skills: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const changed = beginOpenAIObservation({
      sessionId,
      systemPrompt: `${unknown.replace("private-content-0", "private-replaced")}\n## Skills\nprivate-skill\n`,
    });
    expect(changed.changes).toEqual([
      { code: "systemPrompt", detail: "system prompt digest changed (sections: Other)" },
    ]);
    expect(JSON.stringify([first.snapshot, changed])).not.toContain("private-");
  });

  it("reuses section digests when only the other side of the cache boundary changes", () => {
    const sessionId = scopedKey("reused-prompt-sections");
    const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
    const prefix = "## Skills\nlarge-skill-catalog\n## Tooling\ntool descriptions\n";
    const suffix = "## Runtime\nreasoning=off\n";
    const observe = (stable: string, dynamic: string) =>
      beginOpenAIObservation({
        sessionId,
        systemPrompt: `${stable}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamic}`,
      });
    const first = observe(prefix, suffix);
    expect(observe(prefix, suffix).changes).toBeNull();
    const second = observe(prefix, `${suffix}new runtime fact\n`);
    expect(second.snapshot.systemPromptSections).toEqual(first.snapshot.systemPromptSections);
    expect(
      hashes.mock.calls.filter(([value]) => value === "## Skills\nlarge-skill-catalog\n"),
    ).toHaveLength(1);
    expect(second.changes).toEqual([
      {
        code: "systemPromptSuffix",
        detail: "system prompt suffix digest changed (sections: Runtime)",
      },
    ]);
  });

  it("attributes dynamic system prompt suffix changes separately from the stable prefix", () => {
    const sessionId = scopedKey("dynamic-system-suffix");
    const stablePrefix = "stable instructions and tool capability directory";
    beginPromptCacheObservation({
      messages: [],
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}first turn context`,
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });

    const next = beginPromptCacheObservation({
      messages: [],
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}second turn context`,
      tools: [{ name: "read" }],
    });

    // The stable prefix digest is unchanged; only the suffix moved, which a
    // prefix-literal cache (OpenAI Responses `instructions`) still re-caches.
    expect(next.changes).toEqual([
      { code: "systemPromptSuffix", detail: "system prompt suffix digest changed" },
    ]);
    expect(
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 2_000, input: 12_000 } }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [{ code: "systemPromptSuffix", detail: "system prompt suffix digest changed" }],
    });
  });

  it.each([
    {
      change: "schema",
      override: { parameters: { type: "number" } },
      detail: '1 -> 1 tools; schema: "read"',
    },
    {
      change: "description",
      override: { description: "Read a workspace file" },
      detail: '1 -> 1 tools; description: "read"',
    },
    {
      change: "replacement",
      override: { name: "write" },
      detail: '1 -> 1 tools; added: "write"; removed: "read"',
    },
    { change: "removal", override: undefined, detail: '1 -> 0 tools; removed: "read"' },
  ])("attributes a tool $change to the changed definition", ({ override, detail }) => {
    const sessionId = scopedKey("changed-tool-schema");
    const tool = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    beginOpenAIObservation({
      sessionId,
      tools: collectPromptCacheTools([tool]),
    });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });

    const next = beginOpenAIObservation({
      sessionId,
      tools: collectPromptCacheTools(override ? [{ ...tool, ...override }] : []),
    });

    expect(next.changes).toEqual([{ code: "tools", detail }]);
    expect(completePromptCacheObservation({ sessionId, usage: { cacheRead: 0 } })).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 0,
      changes: [{ code: "tools", detail }],
    });
  });

  it("bounds and escapes names in tool-change diagnostics without exposing descriptor content", () => {
    const sessionId = scopedKey("bounded-tool-change");
    beginOpenAIObservation({ sessionId, tools: [] });
    const next = beginOpenAIObservation({
      sessionId,
      tools: collectPromptCacheTools(
        Array.from({ length: 6 }, (_, index) => ({
          name: `${index}\n${"x".repeat(500)}`,
          description: "private descriptor",
        })),
      ),
    });
    const detail = next.changes?.[0]?.detail ?? "";
    expect(detail).toContain('added: "0\\n');
    expect(detail).toContain("(+1 more)");
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("private descriptor");
    expect(detail.length).toBeLessThan(500);
  });

  it("starts a fresh diagnostic baseline when a cache affinity rotates sessions", () => {
    const promptCacheKey = scopedKey("openclaw-cron-stable-cache-key");
    const observe = (sessionId: string, cacheRead: number) => {
      const identity = { sessionId, promptCacheKey, sessionKey: `agent:cron:run:${sessionId}` };
      beginOpenAIObservation({
        ...identity,
        messages: [{ role: "user", content: sessionId, timestamp: 1 }],
      });
      return completePromptCacheObservation({
        ...identity,
        usage: { input: 100, cacheRead },
      });
    };

    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      expect(observe("isolated-run-1", 8_000)).toBeNull();
      expect(observe("isolated-run-2", 2_000)).toBeNull();
      expect(observe("isolated-run-2", 0)).toEqual({
        previousCacheRead: 2_000,
        cacheRead: 0,
        changes: null,
      });
    });
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginOpenAIObservation({
      sessionId: scopedKey("session-0"),
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-0"),
      usage: { cacheRead: 8_000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginOpenAIObservation({
        sessionId: scopedKey(`session-${index}`),
        systemPrompt: `stable system ${index}`,
      });
    }

    const restarted = beginOpenAIObservation({
      sessionId: scopedKey("session-0"),
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginOpenAIObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      cacheRetention: "long",
      transport: "sse",
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      usage: { cacheRead: 8_000 },
    });

    beginOpenAIObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      cacheRetention: "short",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
    });

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        sessionKey: scopedKey("agent:main"),
      }),
    ).toBeNull();

    const resumed = beginOpenAIObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      cacheRetention: "short",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
    });

    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: null,
    });
  });
});
