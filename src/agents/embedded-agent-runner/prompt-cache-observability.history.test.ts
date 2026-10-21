import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import {
  normalizeTranscriptJsonValue,
  isOwnedTranscriptPayload,
} from "../../config/sessions/transcript-json.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { Message, TextContent } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { transformTransportMessages } from "../transport-message-transform.js";
import { log } from "./logger.js";
import {
  completePromptCacheObservation,
  declarePromptHistoryRewrite,
  declarePromptToolPin,
} from "./prompt-cache-observability.js";
import { beginOpenAIObservation } from "./prompt-cache-observability.test-support.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import type { PromptPreparationResult, PromptPreparationTask } from "./provider-prompt-state.js";

// mock-isolation: Preserve native hashing while observing history work in this process.
vi.mock("node:crypto", { spy: true });

let testScope = 0;

function scopedKey(value: string): string {
  return `history:${value}:${testScope}`;
}

describe("prompt cache history fingerprints", () => {
  beforeEach(() => {
    testScope += 1;
    vi.mocked(crypto.hash).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["model context", "openai-responses"],
    ["model context", "anthropic-messages"],
    ["transport", "openai-responses"],
    ["transport", "anthropic-messages"],
  ] as const)("keeps repaired %s history stable for %s", async (route, api) => {
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const model = makeProviderModelFixture({
        api,
        provider: api === "openai-responses" ? "openai" : "anthropic",
        id: "test-model",
        baseUrl: "https://example.test",
      });
      const source: Message[] = [
        makeAgentAssistantMessage({
          api,
          provider: model.provider,
          content: [{ type: "toolCall", id: "missing", name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 7,
        }),
      ];
      const replay = () =>
        route === "model context"
          ? convertToLlm(sanitizeToolUseResultPairingForModel(source, api === "openai-responses"))
          : transformTransportMessages(source, model);
      const observer = createPromptCacheRequestObserver(
        { sessionId: scopedKey(`${route}:${api}`), streamStrategy: "test" },
        () => {},
      );
      const first = replay();
      await observer.onModelRequest(model, { messages: first });
      observer.onModelUsage({
        contextUsage: { state: "available", promptTokens: 200, totalTokens: 250 },
      });
      clock.mockReturnValue(2_000);
      source.push({ role: "user", content: "Continue", timestamp: 8 });
      const next = replay();
      expect(await observer.onModelRequest(model, { messages: next })).toMatchObject({
        requestIndex: 2,
        prefixUnchanged: true,
        changes: null,
      });
      expect(next.slice(0, first.length)).toEqual(first);
      expect(observer.getContextUsage()).toMatchObject({ requestIndex: 1, contextTokens: 250 });
      expect(source.map(({ role }) => role)).toEqual(["assistant", "user"]);
    });
  });

  it("keeps a two-turn tool loop append-only with bounded block hashing", async () => {
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
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
      const hashes = vi.mocked(crypto.hash);
      const observed = vi.fn();
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        observed,
      );
      const request = async () => {
        const messages = convertToLlm(source);
        await observer.onModelRequest(
          { provider: "openai", id: "test-model", api: "openai-responses" },
          { messages },
        );
        observer.onModelUsage({ cacheRead: 8_000 });
        return messages;
      };
      const first = await request();
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
      const loop = await request();
      source.push(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Read complete" }],
          timestamp: 5,
        }),
        { role: "user", content: "Summarize it", timestamp: 6 },
      );
      await request();
      expect(loop[0]).toBe(first[0]);
      expect(loop[1]).not.toBe(first[1]);
      expect(loop[1]?.content).toBe(first[1]?.content);
      for (const text of ["Read the fixture", "Fixture context", "fixture result"]) {
        expect(
          hashes.mock.calls.filter(
            ([, value]) => typeof value === "string" && value.includes(text),
          ),
        ).toHaveLength(1);
      }
      expect(observed).toHaveBeenCalledTimes(3);
      for (const [observation] of observed.mock.calls) {
        expect(observation.changes).toBeNull();
      }
    });
  });

  it("prepares sealed history off-thread and detects replacement publications", async () => {
    const publish = (path: string) => {
      const entry = {
        message: makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }],
          timestamp: 1,
        }),
      };
      normalizeTranscriptJsonValue(entry, "entry");
      return entry.message;
    };
    const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
    const observer = createPromptCacheRequestObserver(
      { sessionId: scopedKey("sealed-history"), streamStrategy: "test" },
      () => {},
    );
    const message = publish("sealed-history-fixture");
    expect(isOwnedTranscriptPayload(message)).toBe(true);
    const hashes = vi.mocked(crypto.hash);
    const messages: Message[] = [message];
    await observer.onModelRequest(model, { messages });
    expect(
      hashes.mock.calls.some(
        ([, text]) => typeof text === "string" && text.includes("sealed-history-fixture"),
      ),
    ).toBe(false);
    messages.push({ role: "user", content: "continue", timestamp: 2 });
    expect(await observer.onModelRequest(model, { messages })).toMatchObject({
      prefixUnchanged: true,
      changes: null,
    });
    // Reopening an identical publication must compare by content, not object identity.
    messages[0] = publish("sealed-history-fixture");
    expect(await observer.onModelRequest(model, { messages })).toMatchObject({
      prefixUnchanged: true,
      changes: null,
    });
    messages[0] = publish("replacement");
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
      await expect(observer.onModelRequest(model, { messages })).rejects.toThrow(
        "changed fields: content[0].arguments",
      );
    });
  });

  it("reuses owned content under mutable append envelopes across observers", async () => {
    const args = { options: { path: "before-append" } };
    const message = makeAgentAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: args,
        },
      ],
      timestamp: 1,
    });
    // A live message can be observed and edited before append seals its content.
    beginOpenAIObservation({ sessionId: scopedKey("before-append"), messages: [message] });
    args.options.path = "owned-arguments-fixture";
    // The append owner normalizes the message itself, rather than its enclosing entry.
    normalizeTranscriptJsonValue(message, "");
    expect(isOwnedTranscriptPayload(message)).toBe(false);
    expect(isOwnedTranscriptPayload(message.content)).toBe(true);
    const observers = ["first", "second"].map((name) =>
      createPromptCacheRequestObserver(
        { sessionId: scopedKey(name), streamStrategy: "test" },
        () => {},
      ),
    );
    const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
    const hashes = vi.mocked(crypto.hash);
    hashes.mockClear();
    for (let turn = 0; turn < 3; turn++) {
      for (const observer of observers) {
        expect(
          await observer.onModelRequest(model, { messages: convertToLlm([message]) }),
        ).toMatchObject({ changes: null });
      }
    }
    expect(
      hashes.mock.calls.filter(
        ([, text]) => typeof text === "string" && text.includes("owned-arguments-fixture"),
      ),
    ).toHaveLength(1);

    message.content = [
      { type: "toolCall", id: "call-1", name: "read", arguments: { options: { path: "changed" } } },
    ];
    for (const observer of observers) {
      expect(
        await observer.onModelRequest(model, { messages: convertToLlm([message]) }),
      ).toMatchObject({
        changes: [
          { code: "historyRewrite", detail: expect.stringContaining("content[0].arguments") },
        ],
      });
    }
  });

  it.each([false, true])(
    "ignores internal tool-result envelopes but detects content rewrites (sealed=%s)",
    async (sealed) => {
      await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
        const observer = createPromptCacheRequestObserver(
          { sessionId: scopedKey("tool-result-envelope"), streamStrategy: "test" },
          () => {},
        );
        const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
        const publish = (text: string, metadata?: Record<string, unknown>) => {
          const entry = {
            message: {
              role: "toolResult" as const,
              toolCallId: "exec-1",
              toolName: "exec",
              content: [{ type: "text" as const, text }],
              isError: false,
              timestamp: 1,
              ...(metadata ? { __openclaw: metadata } : {}),
            },
          };
          if (sealed) {
            normalizeTranscriptJsonValue(entry, "entry");
          }
          return entry.message;
        };
        await observer.onModelRequest(model, { messages: [publish("fixture result")] });
        const metadata = {
          runId: "fixture-run",
          codeModeCheckpoint: { status: "completed", replaySafe: true },
        };
        const message = publish("fixture result", metadata);
        expect(await observer.onModelRequest(model, { messages: [message] })).toMatchObject({
          prefixUnchanged: true,
          changes: null,
        });
        const withoutEnvelope = sealed ? publish("fixture result") : message;
        if (!sealed) {
          delete withoutEnvelope["__openclaw"];
        }
        expect(await observer.onModelRequest(model, { messages: [withoutEnvelope] })).toMatchObject(
          { prefixUnchanged: true, changes: null },
        );
        await expect(
          observer.onModelRequest(model, { messages: [publish("rewritten result", metadata)] }),
        ).rejects.toThrow("changed fields: content[0].text");
      });
    },
  );

  it("cancels worker preparation without recording a request or hashing locally", async () => {
    const controller = new AbortController();
    const entry = { message: { role: "user" as const, content: "x".repeat(4096), timestamp: 1 } };
    normalizeTranscriptJsonValue(entry, "entry");
    const onRequest = vi.fn();
    const observer = createPromptCacheRequestObserver(
      { sessionId: scopedKey("cancel-preparation"), streamStrategy: "test" },
      () => {},
      onRequest,
    );
    // A prior file can own the pool through an earlier module evaluation.
    const pool = resolveGlobalSingleton<
      WorkerTaskPool<PromptPreparationTask, PromptPreparationResult>
    >(Symbol.for("openclaw.providerPromptHashPool"), () => {
      throw new Error("Expected the prompt observer to initialize its worker pool");
    });
    const hashes = vi.mocked(crypto.hash);
    const prepare = vi.spyOn(pool, "run").mockImplementation((_input, options) => {
      expect(options.inputBytes).toBeGreaterThanOrEqual(entry.message.content.length * 2);
      const error = new Error("fixture request canceled");
      controller.abort(error);
      return Promise.reject(error);
    });
    await expect(
      observer.onModelRequest(
        { provider: "openai", id: "test-model", api: "openai-responses" },
        { messages: [entry.message] },
        controller.signal,
      ),
    ).rejects.toThrow("fixture request canceled");
    expect(prepare).toHaveBeenCalledOnce();
    expect(hashes).not.toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("does not rehash an unchanged history prefix when a request appends a message", () => {
    const sessionId = scopedKey("incremental-prefix");
    const messages: Message[] = Array.from({ length: 100 }, (_, timestamp) => ({
      role: "user",
      content: [{ type: "text", text: `Synthetic history ${timestamp}` }],
      timestamp,
    }));
    const hashes = vi.mocked(crypto.hash);
    beginOpenAIObservation({ sessionId, messages });
    hashes.mockClear();
    messages.push({ role: "user", content: "Next turn", timestamp: 100 });
    expect(beginOpenAIObservation({ sessionId, messages })).toMatchObject({
      prefixUnchanged: true,
      changes: null,
    });
    // Hash work grows with the new message, not the retained prefix.
    expect(hashes.mock.calls.length).toBeLessThan(10);
  });

  it.each([
    ["block", false, "original", "rewritten"],
    ["block", true, "original", "rewritten"],
    ["string", false, "original", "rewritten"],
    ["string", true, "original", "rewritten"],
    ["block", false, "\ud800", "\ud801"],
    ["string", false, "\ud800", "\ud801"],
  ] as const)(
    "detects mutated %s text (rebuilt wrapper=%s)",
    (kind, rebuildWrapper, original, rewritten) => {
      const sessionId = scopedKey(`mutated-${kind}`);
      const block: TextContent = { type: "text", text: original };
      const first: Message = { role: "user", content: "question", timestamp: 1 };
      const message: Message =
        kind === "string"
          ? { role: "user", content: original, timestamp: 2 }
          : makeAgentAssistantMessage({ content: [block], timestamp: 2 });
      beginOpenAIObservation({ sessionId, messages: [first, message] });
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
      if (message.role === "user") {
        message.content = rewritten;
      } else {
        block.text = rewritten;
      }
      const detail = `message 1 (${message.role}) differs from the previous request; history must be append-only; changed fields: ${kind === "string" ? "content" : "content[0].text"}`;
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        expect(() =>
          beginOpenAIObservation({
            sessionId,
            messages: [first, rebuildWrapper ? { ...message } : message],
          }),
        ).toThrow(detail);
      });
      expect(
        completePromptCacheObservation({ sessionId, usage: { input: 8_000, cacheRead: 0 } })
          ?.changes,
      ).toEqual([{ code: "historyRewrite", detail }]);
    },
  );

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
        "changed fields: content[0].arguments",
      );
    });
  });

  it("names changed reasoning signatures without exposing values or extension keys", () => {
    const sessionId = scopedKey("reasoning-fields");
    const block = {
      type: "thinking" as const,
      thinking: "private reasoning",
      thinkingSignature: "private original signature",
      "private-extension-name": "original extension value",
    };
    const message = makeAgentAssistantMessage({ content: [block] });
    beginOpenAIObservation({ sessionId, messages: [message] });
    block.thinkingSignature = "private rewritten signature";
    block["private-extension-name"] = "rewritten extension value";
    const changes = beginOpenAIObservation({ sessionId, messages: [message] }).changes;
    expect(changes).toEqual([
      {
        code: "historyRewrite",
        detail:
          "message 0 (assistant) differs from the previous request; history must be append-only; changed fields: content[0].thinkingSignature, content[0].other",
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain("private");
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
      const hashes = vi.mocked(crypto.hash);
      for (let index = 0; index < 3; index++) {
        expect(
          beginOpenAIObservation({ sessionId, messages: [{ ...message }] }).changes,
        ).toBeNull();
      }
      expect(
        hashes.mock.calls.filter(
          ([, value]) => typeof value === "string" && value.includes("large-content-fixture"),
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
            ? "changed fields: content[0].text"
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
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
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
      completePromptCacheObservation({ sessionId });
      beginOpenAIObservation({ sessionId, messages: [message] });
      expect(
        completePromptCacheObservation({ sessionId, usage: { cacheRead: 2_000 } })?.changes,
      ).toEqual([
        {
          code: "historyRewrite",
          detail: `message 0 (user) differs from the previous request; history must be append-only; changed fields: envelope.${label}`,
        },
      ]);
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
        "changed fields: content[0].text, content[1].text, content[2].text, content[3].text, content[4].text, content[5].text, content[6].text, content[7].text, …",
      );
    });
  });

  it("asserts an undeclared tool block change and admits one declared pin change", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("tool-pin");
      beginOpenAIObservation({ sessionId, tools: [{ name: "read" }] });
      expect(() =>
        beginOpenAIObservation({ sessionId, tools: [{ name: "read" }, { name: "exec" }] }),
      ).toThrow("prefix changed within session: tools(");
      declarePromptToolPin({ sessionId });
      beginOpenAIObservation({ sessionId, tools: [{ name: "read" }, { name: "gateway" }] });
      expect(() => beginOpenAIObservation({ sessionId, tools: [{ name: "read" }] })).toThrow(
        "prefix changed within session: tools(",
      );
    });
  });

  it.each(["compaction", "pruning", "runtimeContextCarrier"] as const)(
    "consumes a declared %s rewrite for exactly one request",
    (reason) => {
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        const sessionId = scopedKey(reason);
        const messages: Message[] = [{ role: "user", content: "before", timestamp: 1 }];
        expect(beginOpenAIObservation({ sessionId, messages }).prefixUnchanged).toBe(false);
        const appended: Message[] = [
          ...messages,
          { role: "user", content: "appended", timestamp: 2 },
        ];
        declarePromptHistoryRewrite({ sessionId, reason });
        expect(beginOpenAIObservation({ sessionId, messages: appended })).toMatchObject({
          prefixUnchanged: true,
          changes: [{ code: reason, detail: `${reason} changed provider history` }],
        });
        declarePromptHistoryRewrite({ sessionId, reason });
        const rewritten: Message[] = [{ role: "user", content: "after", timestamp: 1 }];
        expect(beginOpenAIObservation({ sessionId, messages: rewritten })).toMatchObject({
          prefixUnchanged: false,
          changes: [{ code: reason, detail: `${reason} changed provider history` }],
        });
        expect(beginOpenAIObservation({ sessionId, messages: rewritten })).toMatchObject({
          prefixUnchanged: true,
          changes: null,
        });
        expect(() => beginOpenAIObservation({ sessionId, messages })).toThrow("message 0 (user)");
      });
    },
  );

  it.each(["compaction", "pruning", "runtimeContextCarrier"] as const)(
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
});
