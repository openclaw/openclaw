import * as cryptoDigest from "@openclaw/normalization-core/node-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import type { Message, TextContent } from "../../llm/types.js";
import { withEnv } from "../../test-utils/env.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { log } from "./logger.js";
import {
  completePromptCacheObservation,
  declarePromptHistoryRewrite,
} from "./prompt-cache-observability.js";
import { beginOpenAIObservation } from "./prompt-cache-observability.test-support.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";

let testScope = 0;

function scopedKey(value: string): string {
  return `history:${value}:${testScope}`;
}

describe("prompt cache history fingerprints", () => {
  beforeEach(() => {
    testScope += 1;
  });
  afterEach(() => vi.restoreAllMocks());

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
});
