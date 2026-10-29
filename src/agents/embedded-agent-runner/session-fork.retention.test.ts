import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../ai-transport-runtime-host.js";
import type { Context, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { StreamFn } from "../runtime/index.js";
import {
  recordEmbeddedSessionForkMessage,
  runEmbeddedSessionFork,
  wrapStreamFnWithSessionFork,
} from "./session-fork.js";
const context: Context = {
  systemPrompt: "Stable instructions",
  messages: [{ role: "user", content: "Parent question", timestamp: 1 }],
};
const model: Model = {
  provider: "openai",
  id: "fork-test",
  name: "Fork test",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const identity = { agentId: "main", sessionId: "fork-test", runId: "fork-parent" };

function transport(payloads: Record<string, unknown>[], tools: unknown[]): StreamFn {
  return async (requestModel, requestContext, options) => {
    const key = requestModel.api === "anthropic-messages" ? "messages" : "input";
    const payload = {
      model: requestModel.id,
      system: requestContext.systemPrompt,
      tools,
      [key]: requestContext.messages.map((message) => structuredClone(message)),
    };
    const prepared = (await options?.onPayload?.(payload, requestModel)) ?? payload;
    if (!isRecord(prepared)) {
      throw new Error("Expected provider request");
    }
    payloads.push(prepared);
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      content: [{ type: "text", text: "Answer" }],
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 10,
        output: 1,
        cacheRead: 9,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return stream;
  };
}

async function fork(requestModel = model) {
  return runEmbeddedSessionFork({
    ...identity,
    model: requestModel,
    apiKey: "synthetic-key",
    question: "Review only",
    assertCurrent: () => {},
  });
}

afterEach(() => {
  cleanupSessionResources();
  vi.restoreAllMocks();
});
describe("bounded fork retained data", () => {
  it("preserves the committed prefix when replacement option copying fails", async () => {
    const payloads: Record<string, unknown>[] = [];
    const parent = wrapStreamFnWithSessionFork(transport(payloads, []), identity);
    await (await parent(model, context, {})).result();
    const copy = vi
      .spyOn(Blob.prototype, "arrayBuffer")
      .mockRejectedValueOnce(new Error("unavailable"));
    try {
      await (
        await parent(
          model,
          { messages: [{ role: "user", content: "Replacement prefix", timestamp: 3 }] },
          {
            metadata: { blob: new Blob(["Options"]) },
          },
        )
      ).result();
    } finally {
      copy.mockRestore();
    }
    await expect(fork()).resolves.toBe("Answer");
    expect(JSON.stringify(payloads.at(-1)?.input)).toContain("Parent question");
    expect(JSON.stringify(payloads.at(-1)?.input)).not.toContain("Replacement prefix");
  });

  it("isolates nested request options from both parent and successive fork mutation", async () => {
    const seen: number[] = [];
    const downstream = transport([], []);
    const parent = wrapStreamFnWithSessionFork(async (m, c, o) => {
      const budgets = o?.thinkingBudgets;
      if (budgets) {
        seen.push(budgets.high!);
        budgets.high = 99;
      }
      return downstream(m, c, o);
    }, identity);
    const budgets = { high: 4096 };
    await (await parent(model, context, { thinkingBudgets: budgets })).result();
    budgets.high = 1;
    await expect(fork()).resolves.toBe("Answer");
    await expect(fork()).resolves.toBe("Answer");
    expect(seen).toEqual([4096, 4096, 4096]);
  });

  it.each(["entry overhead", "opaque publications", "backing buffer"] as const)(
    "bounds retained snapshots including %s within 64 MiB",
    async (kind) => {
      const count = kind === "entry overhead" ? 64 : 3;
      const payload = "x".repeat(kind === "entry overhead" ? 1024 * 1024 - 1024 : 1);
      const ids = Array.from({ length: count }, (_, index) => ({
        ...identity,
        sessionId: "budget-" + index,
      }));
      const stream: StreamFn = async (m, c, o) => {
        await o?.onPayload?.({ input: c.messages }, m);
        const result = createAssistantMessageEventStream();
        result.end({
          role: "assistant",
          api: m.api,
          provider: m.provider,
          model: m.id,
          content: [{ type: "text", text: "Answer" }],
          stopReason: "stop",
          timestamp: 2,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        return result;
      };
      for (const id of ids) {
        await (
          await wrapStreamFnWithSessionFork(stream, id)(
            model,
            { messages: [{ role: "user", content: payload, timestamp: 1 }] },
            {},
          )
        ).result();
        if (kind !== "entry overhead") {
          recordEmbeddedSessionForkMessage(id.sessionId, id.runId, {
            role: "toolResult",
            toolCallId: "lookup",
            toolName: "lookup",
            content: [],
            isError: false,
            timestamp: 2,
            details:
              kind === "opaque publications"
                ? { blob: new Blob([new Uint8Array(22 * 1024 * 1024)]) }
                : { bytes: new Uint8Array(new ArrayBuffer(22 * 1024 * 1024), 0, 1) },
          });
        }
      }
      const review = (sessionId: string) =>
        runEmbeddedSessionFork({
          ...identity,
          sessionId,
          model,
          question: "Review only",
          assertCurrent() {},
        });
      await expect(review(ids[0]!.sessionId)).rejects.toThrow("requires a parent turn");
      await expect(review(ids.at(-1)!.sessionId)).resolves.toBe("Answer");
    },
  );

  it("detaches sliced Blob publications and isolates opaque bytes across repeated forks", async () => {
    const downstream = transport([], []);
    const seen: Array<{ byte: number; text: string }> = [];
    const parent = wrapStreamFnWithSessionFork(async (m, c, o) => {
      const result = c.messages.find((message) => message.role === "toolResult");
      if (result?.role === "toolResult") {
        const details = result.details as { bytes: Uint8Array; blob: Blob };
        seen.push({ byte: details.bytes[0]!, text: await details.blob.text() });
        details.bytes[0] = 99;
      }
      return downstream(m, c, o);
    }, identity);
    await (await parent(model, context, {})).result();
    const bytes = new Uint8Array([7]);
    recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, {
      role: "toolResult",
      toolCallId: "lookup",
      toolName: "lookup",
      content: [],
      isError: false,
      timestamp: 2,
      details: { bytes, blob: new Blob(["discard|Opaque result|discard"]).slice(8, 21) },
    });
    bytes[0] = 42;
    await expect(fork()).resolves.toBe("Answer");
    await expect(fork()).resolves.toBe("Answer");
    expect(seen).toEqual([
      { byte: 7, text: "Opaque result" },
      { byte: 7, text: "Opaque result" },
    ]);
  });

  it.each(["retire", "replace"] as const)(
    "does not publish stale async Blob options after %s",
    async (action) => {
      const downstream = transport([], []);
      const parent = wrapStreamFnWithSessionFork(downstream, identity);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const original = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer")!.value as (
        this: Blob,
      ) => Promise<ArrayBuffer>;
      const copy = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementationOnce(async function (
        this: Blob,
      ) {
        entered.resolve();
        await release.promise;
        return original.call(this);
      });
      const pending = parent(
        model,
        { messages: [{ role: "user", content: "Stale prefix", timestamp: 1 }] },
        { metadata: { blob: new Blob(["options"]) } },
      );
      try {
        await entered.promise;
        if (action === "retire") {
          cleanupSessionResources(identity.sessionId);
        } else {
          await (await parent(model, context, {})).result();
        }
        release.resolve();
        await (await pending).result();
        if (action === "retire") {
          await expect(fork()).rejects.toThrow("requires a parent turn");
        } else {
          await expect(fork()).resolves.toBe("Answer");
        }
      } finally {
        release.resolve();
        copy.mockRestore();
        await pending;
      }
    },
  );
});
