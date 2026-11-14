import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { convertProviderResponsesMessages } from "../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { normalizeTranscriptJsonValue } from "../../config/sessions/transcript-json-normalize.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { cloneTranscriptView } from "../../config/sessions/transcript-snapshot.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { Message, TextContent } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../harness/transcript-visibility.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { transformTransportMessages } from "../transport-message-transform.js";
import { log } from "./logger.js";
import { fingerprintMessage, messageFingerprints } from "./prompt-cache-history.js";
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

const unchangedPrefix = { prefixUnchanged: true, changes: null };
const openAIModel = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
function observerFor(key: string) {
  return createPromptCacheRequestObserver(
    { sessionId: scopedKey(key), streamStrategy: "test" },
    () => {},
  );
}
function observe(sessionId: string, messages: Message[]) {
  return beginOpenAIObservation({ sessionId, messages });
}
function contentHashes(text: string) {
  return vi
    .mocked(crypto.hash)
    .mock.calls.filter(([, value]) => typeof value === "string" && value.includes(text));
}
function history(key: string, messages: Message[]) {
  const sessionId = scopedKey(key);
  const read = (next = messages) => observe(sessionId, next);
  read();
  return {
    read,
    complete(usage?: Parameters<typeof completePromptCacheObservation>[0]["usage"]) {
      return completePromptCacheObservation({ sessionId, usage });
    },
    assertRewrite(detail: string, next = messages) {
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        expect(() => read(next)).toThrow(detail);
      });
    },
  };
}
describe("prompt cache history fingerprints", () => {
  beforeEach(() => {
    testScope += 1;
    vi.mocked(crypto.hash).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["string", "blocks"] as const)(
    "keeps %s content stable across append and sealed ownership",
    async (kind) => {
      const message: Message = {
        role: "user",
        timestamp: 7,
        content:
          kind === "string"
            ? "hello\ud800"
            : [
                { type: "text", text: "hello\ud800" },
                { type: "image", data: "abc", mimeType: "image/png" },
              ],
      };
      const observer = observerFor(kind);
      await observer.onModelRequest(openAIModel, { messages: [message] });
      for (const ownership of ["append", "sealed"] as const) {
        const copy = structuredClone(message);
        normalizeTranscriptJsonValue(ownership === "sealed" ? { message: copy } : copy, "");
        expect(await observer.onModelRequest(openAIModel, { messages: [copy] })).toMatchObject(
          unchangedPrefix,
        );
      }
    },
  );

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
      const observer = observerFor(`${route}:${api}`);
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
        makeTextToolResult("read-1", "read", "fixture result", false, 4),
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
        expect(contentHashes(text)).toHaveLength(1);
      }
      expect(observed).toHaveBeenCalledTimes(3);
      for (const [observation] of observed.mock.calls) {
        expect(observation.changes).toBeNull();
      }
    });
  });

  it("keeps recovered coordination history stable when persistence adds display metadata", async () => {
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
      const model = makeProviderModelFixture({
        api: "openai-responses",
        provider: "openai",
        id: "test-model",
        baseUrl: "https://example.test",
      });
      const live = makeAgentAssistantMessage({
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 1,
      });
      const persisted = projectAgentHarnessTranscriptMessageForDisplay({
        hidden: true,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        message: live,
      });
      const before = convertToLlm([live]);
      const recovered = convertToLlm([structuredClone(persisted)]);
      expect(live).not.toHaveProperty("display");
      expect(recovered[0]).toHaveProperty("display", false);
      const wire = (messages: Message[]) =>
        JSON.stringify(convertProviderResponsesMessages(model, { messages }, new Set(["openai"])));
      expect(wire(recovered)).toBe(wire(before));
      const observer = observerFor("recovered-coordination");
      await observer.onModelRequest(model, { messages: before });
      recovered.push({ role: "user", content: "Continue after recovery", timestamp: 2 });
      expect(await observer.onModelRequest(model, { messages: recovered })).toMatchObject(
        unchangedPrefix,
      );
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
    const observer = observerFor("sealed-history");
    const message = publish("sealed-history-fixture");
    expect(isOwnedTranscriptPayload(message)).toBe(true);
    const hashes = vi.mocked(crypto.hash);
    const messages: Message[] = [message];
    await observer.onModelRequest(openAIModel, { messages });
    expect(
      hashes.mock.calls.some(
        ([, text]) => typeof text === "string" && text.includes("sealed-history-fixture"),
      ),
    ).toBe(false);
    messages.push({ role: "user", content: "continue", timestamp: 2 });
    expect(await observer.onModelRequest(openAIModel, { messages })).toMatchObject(unchangedPrefix);
    // Reopening an identical publication must compare by content, not object identity.
    messages[0] = publish("sealed-history-fixture");
    expect(await observer.onModelRequest(openAIModel, { messages })).toMatchObject(unchangedPrefix);
    messages[0] = publish("replacement");
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
      await expect(observer.onModelRequest(openAIModel, { messages })).rejects.toThrow(
        "changed fields: content[0].arguments",
      );
    });
  });

  it("prepares shared frozen hydration without retaining mutable revision state", async () => {
    const publish = (path: string) => {
      const message = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }],
        timestamp: 1,
      });
      normalizeTranscriptJsonValue(message, "");
      return Object.freeze(message);
    };
    const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
    const observer = createPromptCacheRequestObserver(
      { sessionId: scopedKey("frozen-hydration"), streamStrategy: "test" },
      () => {},
    );
    const entries = [{ message: publish("frozen-hydration-fixture") }];
    const request = () => {
      const hydrated = cloneTranscriptView(entries);
      expect(hydrated[0]!.message).toBe(entries[0]!.message);
      return observer.onModelRequest(model, {
        messages: convertToLlm(hydrated.map(({ message }) => message)),
      });
    };
    expect(isOwnedTranscriptPayload(entries[0]!.message)).toBe(false);
    await request();
    expect(
      vi
        .mocked(crypto.hash)
        .mock.calls.some(
          ([, text]) => typeof text === "string" && text.includes("frozen-hydration-fixture"),
        ),
    ).toBe(false);
    expect(await request()).toMatchObject({ prefixUnchanged: true, changes: null });
    entries[0]!.message = publish("replacement");
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
      await expect(request()).rejects.toThrow("changed fields: content[0].arguments");
    });
  });

  it("does not republish cached fingerprints when an unchanged history is observed again", () => {
    const messages = Array.from({ length: 200 }, (_, timestamp) => {
      const entry = { message: { role: "user" as const, content: "fixture", timestamp } };
      normalizeTranscriptJsonValue(entry, "entry");
      return entry.message;
    });
    const tracker = history("cached-history", messages);
    const layouts = new Set(messages.map((message) => fingerprintMessage(message).layout));
    const writes = vi.spyOn(messageFingerprints, "set");
    const lookups = vi.spyOn(Map.prototype, "get");
    expect(tracker.read()).toMatchObject(unchangedPrefix);
    expect(writes).not.toHaveBeenCalled();
    expect(lookups.mock.calls.filter(([key]) => layouts.has(key))).toHaveLength(0);
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
    const observers = ["first", "second"].map((name) => observerFor(name));
    const hashes = vi.mocked(crypto.hash);
    hashes.mockClear();
    for (let turn = 0; turn < 3; turn++) {
      for (const observer of observers) {
        expect(
          await observer.onModelRequest(openAIModel, { messages: convertToLlm([message]) }),
        ).toMatchObject({ changes: null });
      }
    }
    expect(contentHashes("owned-arguments-fixture")).toHaveLength(1);

    message.content = [
      { type: "toolCall", id: "call-1", name: "read", arguments: { options: { path: "changed" } } },
    ];
    for (const observer of observers) {
      expect(
        await observer.onModelRequest(openAIModel, { messages: convertToLlm([message]) }),
      ).toMatchObject({
        changes: [
          { code: "historyRewrite", detail: expect.stringContaining("content[0].arguments") },
        ],
      });
    }
  });

  it.each(["string", "blocks"] as const)(
    "reuses unchanged mutable envelopes with immutable %s content across readers",
    (kind) => {
      const messages = [1, 2].map((timestamp) => {
        const message = makeAgentAssistantMessage({
          content: [{ type: "text", text: `fixture-${timestamp}` }],
          timestamp,
        });
        const prepared: Message =
          kind === "string" ? { role: "user", content: "fixture", timestamp } : message;
        normalizeTranscriptJsonValue(prepared, "");
        return prepared;
      });
      const fingerprints = messages.map((message) => fingerprintMessage(message));
      for (let read = 0; read < 3; read++) {
        for (const [index, message] of messages.entries()) {
          expect(fingerprintMessage(message)).toBe(fingerprints[index]);
        }
      }
      const message = messages[0]!;
      message.timestamp++;
      const changed = fingerprintMessage(message, fingerprints[0]);
      expect(changed.packed).not.toBe(fingerprints[0]!.packed);
      expect(fingerprintMessage(message)).toBe(changed);
      if (message.role === "assistant") {
        message.usage = structuredClone(message.usage);
        expect(fingerprintMessage(message)).toBe(changed);
        message.usage.input++;
        expect(fingerprintMessage(message, changed).packed).not.toBe(changed.packed);
      }
      const content: TextContent[] = [{ type: "text", text: "replacement" }];
      message.content = content;
      const replaced = fingerprintMessage(message, changed);
      expect(replaced.packed).not.toBe(changed.packed);
      content[0]!.text = "edited in place";
      expect(fingerprintMessage(message, replaced).packed).not.toBe(replaced.packed);
      normalizeTranscriptJsonValue(message, "");
      fingerprintMessage(message);
      Object.freeze(message);
      fingerprintMessage(message);
      const entries = vi.spyOn(Object, "entries");
      fingerprintMessage(message);
      expect(entries).not.toHaveBeenCalledWith(message);
    },
  );

  it.each([false, true])(
    "ignores internal tool-result envelopes but detects content rewrites (sealed=%s)",
    async (sealed) => {
      await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
        const observer = observerFor("tool-result-envelope");
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
        await observer.onModelRequest(openAIModel, { messages: [publish("fixture result")] });
        const metadata = {
          runId: "fixture-run",
          codeModeCheckpoint: { status: "completed", replaySafe: true },
        };
        const message = publish("fixture result", metadata);
        expect(await observer.onModelRequest(openAIModel, { messages: [message] })).toMatchObject(
          unchangedPrefix,
        );
        const withoutEnvelope = sealed ? publish("fixture result") : message;
        if (!sealed) {
          delete withoutEnvelope["__openclaw"];
        }
        expect(
          await observer.onModelRequest(openAIModel, { messages: [withoutEnvelope] }),
        ).toMatchObject(unchangedPrefix);
        await expect(
          observer.onModelRequest(openAIModel, {
            messages: [publish("rewritten result", metadata)],
          }),
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
      const block: TextContent = { type: "text", text: original };
      const first: Message = { role: "user", content: "question", timestamp: 1 };
      const message: Message =
        kind === "string"
          ? { role: "user", content: original, timestamp: 2 }
          : makeAgentAssistantMessage({ content: [block], timestamp: 2 });
      const tracker = history(`mutated-${kind}`, [first, message]);
      tracker.complete({ cacheRead: 8_000 });
      if (message.role === "user") {
        message.content = rewritten;
      } else {
        block.text = rewritten;
      }
      const detail = `message 1 (${message.role}) differs from the previous request; history must be append-only; changed fields: ${kind === "string" ? "content" : "content[0].text"}`;
      tracker.assertRewrite(detail, [first, rebuildWrapper ? { ...message } : message]);
      expect(tracker.complete({ input: 8_000, cacheRead: 0 })?.changes).toEqual([
        { code: "historyRewrite", detail },
      ]);
    },
  );

  it("detects nested tool arguments mutated in place", () => {
    const args = { options: { path: "before" } };
    const tracker = history("mutated-arguments", [
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: args }],
      }),
    ]);
    args.options.path = "after";
    tracker.assertRewrite("changed fields: content[0].arguments");
  });

  it("names added, changed, and removed extension keys without exposing values", () => {
    const sessionId = scopedKey("reasoning-fields");
    const block = {
      type: "thinking" as const,
      thinking: "private reasoning",
      thinkingSignature: "private original signature",
      changedBlock: "private original block value",
      removedBlock: "private removed block value",
    };
    const message = {
      ...makeAgentAssistantMessage({ content: [block] }),
      changedEnvelope: "private original envelope value",
      removedEnvelope: "private removed envelope value",
    };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    observe(sessionId, [message]);
    block.thinkingSignature = "private rewritten signature";
    block.changedBlock = "private rewritten block value";
    Reflect.deleteProperty(block, "removedBlock");
    Object.assign(block, { addedBlock: "private added block value" });
    message.changedEnvelope = "private rewritten envelope value";
    Reflect.deleteProperty(message, "removedEnvelope");
    Object.assign(message, { addedEnvelope: "private added envelope value" });
    const changes = observe(sessionId, [message]).changes;
    expect(changes).toEqual([
      {
        code: "historyRewrite",
        detail:
          'message 0 (assistant) differs from the previous request; history must be append-only; changed fields: content[0].thinkingSignature, content[0].other["changedBlock"], content[0].other["removedBlock"], content[0].other["addedBlock"], envelope.other["changedEnvelope"], envelope.other["removedEnvelope"], envelope.other["addedEnvelope"]',
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain("private");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('content[0].other["removedBlock"]'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("detects primitive property additions, changes, and removals", () => {
    const block: TextContent = { type: "text", text: "stable" };
    const tracker = history("mutated-properties", [
      makeAgentAssistantMessage({ content: [block] }),
    ]);
    for (const value of [undefined, "signature"]) {
      block.textSignature = value;
      tracker.assertRewrite("message 0 (assistant)");
    }
    delete block.textSignature;
    tracker.assertRewrite("message 0 (assistant)");
  });

  it.each(["__proto__", "constructor", "toString"])(
    "tracks primitive revisions for the own field %s",
    (key) => {
      const block: TextContent & Record<string, unknown> = { type: "text", text: "stable" };
      Object.defineProperty(block, key, {
        value: "original",
        writable: true,
        configurable: true,
        enumerable: true,
      });
      const tracker = history(`own-field-${key}`, [
        makeAgentAssistantMessage({ content: [block] }),
      ]);
      expect(tracker.read()).toMatchObject(unchangedPrefix);
      expect(contentHashes("original")).toHaveLength(1);
      for (const value of [undefined, null, { nested: "value" }, "changed"]) {
        block[key] = value;
        tracker.assertRewrite("changed fields: content[0].other");
        expect(tracker.read()).toMatchObject(unchangedPrefix);
      }
      delete block[key];
      tracker.assertRewrite("changed fields: content[0].other");
    },
  );

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
      for (let index = 0; index < 3; index++) {
        expect(
          beginOpenAIObservation({ sessionId, messages: [{ ...message }] }).changes,
        ).toBeNull();
      }
      expect(contentHashes("large-content-fixture")).toHaveLength(1);
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
      observe(sessionId, messages);
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: undefined }, () => {
        expect(observe(sessionId, changed).changes).toEqual([{ code: "historyRewrite", detail }]);
        expect(
          completePromptCacheObservation({ sessionId, usage: { input: 8_000, cacheRead: 0 } })
            ?.changes,
        ).toEqual([{ code: "historyRewrite", detail }]);
        observe(sessionId, messages);
        expect(warn).toHaveBeenCalledTimes(1);
      });
      withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
        expect(() => observe(sessionId, changed)).toThrow(detail);
      });
    },
  );

  it.each([
    { field: "timestamp", value: 2, label: "timestamp" },
    { field: "idempotencyKey", value: "private-value", label: "idempotencyKey" },
    { field: "usage", value: { input: 42 }, label: "usage" },
    { field: "extensionField", value: "private-value", label: 'other["extensionField"]' },
  ])("identifies changed $label metadata without logging values", ({ field, value, label }) => {
    const sessionId = scopedKey(`metadata-${label}`);
    const message: Message & Record<string, unknown> = {
      role: "user",
      content: "private-prompt",
      timestamp: 1,
    };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    observe(sessionId, [message]);
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
    message[field] = value;
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: undefined }, () => {
      expect(observe(sessionId, [message]).changes).toEqual([
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
    observe(sessionId, [message]);
    expect(
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 2_000 } })?.changes,
    ).toEqual([
      {
        code: "historyRewrite",
        detail: `message 0 (user) differs from the previous request; history must be append-only; changed fields: envelope.${label}`,
      },
    ]);
  });

  it("bounds diagnostics while detecting changes beyond the retained block prefix", () => {
    const blocks: TextContent[] = Array.from({ length: 20 }, () => ({
      type: "text",
      text: "before",
    }));
    const tracker = history("bounded-content-diff", [
      makeAgentAssistantMessage({ content: blocks }),
    ]);
    blocks[19]!.text = "private-rewritten-content";
    tracker.assertRewrite("changed fields: content[remaining]");
    for (const block of blocks) {
      block.text = "private-second-rewrite";
    }
    tracker.assertRewrite(
      "changed fields: content[0].text, content[1].text, content[2].text, content[3].text, content[4].text, content[5].text, content[6].text, content[7].text, …",
    );
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
        expect(observe(sessionId, messages).prefixUnchanged).toBe(false);
        const appended: Message[] = [
          ...messages,
          { role: "user", content: "appended", timestamp: 2 },
        ];
        declarePromptHistoryRewrite({ sessionId, reason });
        expect(observe(sessionId, appended)).toMatchObject({
          prefixUnchanged: true,
          changes: [{ code: reason, detail: `${reason} changed provider history` }],
        });
        declarePromptHistoryRewrite({ sessionId, reason });
        const rewritten: Message[] = [{ role: "user", content: "after", timestamp: 1 }];
        expect(observe(sessionId, rewritten)).toMatchObject({
          prefixUnchanged: false,
          changes: [{ code: reason, detail: `${reason} changed provider history` }],
        });
        expect(observe(sessionId, rewritten)).toMatchObject(unchangedPrefix);
        expect(() => observe(sessionId, messages)).toThrow("message 0 (user)");
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

  it("does not reuse a digest for a different tool-call identity", () => {
    const result: Message = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "first",
      content: [],
      isError: false,
      timestamp: 1,
    };
    history("shared-content", [result]).assertRewrite("message 0 (toolResult)", [
      { ...result, toolCallId: "second" },
    ]);
  });
});
