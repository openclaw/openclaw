import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("OpenCode Go Kimi reasoning replay", () => {
  it.each([false, true])(
    "sanitizes deeply nested content through the registered wrapper (standalone=%s)",
    async (standalone) => {
      vi.useFakeTimers();
      try {
        const leaf = {
          content: [{ type: "thinking", text: "omitted" }],
          reasoning: "omitted",
          metadata: { reasoning: "unrelated metadata" },
        };
        let content: Record<string, unknown> = leaf;
        const containers: Record<string, unknown>[] = [];
        const textPart = { type: "text", text: "visible" };
        for (let depth = 0; depth < 50_000; depth++) {
          content = {
            content: [{ type: "reasoning" }, content, textPart],
            reasoning_content: "omitted",
          };
          containers.push(content);
        }

        const payload = { model: "kimi-k2.6", messages: [content], input: [content] };
        const provider = await registerSingleProviderPlugin(plugin);
        const model: Parameters<StreamFn>[0] = {
          id: payload.model,
          name: payload.model,
          provider: "opencode-go",
          api: standalone ? "openclaw-provider-simple:synthetic" : "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
          reasoning: true,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        const baseStreamFn = vi.fn<StreamFn>((runtimeModel, _context, options) => {
          void options?.onPayload?.(payload, runtimeModel);
          const stream = createAssistantMessageEventStream();
          stream.end();
          return stream;
        });
        const wrap = standalone ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
        const streamFn = wrap?.({
          streamFn: baseStreamFn,
          provider: "opencode-go",
          modelId: model.id,
          model,
          sourceApi: standalone ? "openai-completions" : undefined,
          thinkingLevel: "high",
        });
        expect(streamFn).toBeTypeOf("function");
        await streamFn?.(model, { messages: [] }, {});

        expect(baseStreamFn).toHaveBeenCalledOnce();
        expect(payload.messages).toEqual([content]);
        expect(payload.input).toEqual([content]);
        expect(containers.every((entry) => !Object.hasOwn(entry, "reasoning_content"))).toBe(true);
        expect(
          containers.every(
            (entry, index) =>
              Array.isArray(entry.content) &&
              entry.content.length === 2 &&
              entry.content[0] === (index === 0 ? leaf : containers[index - 1]) &&
              entry.content[1] === textPart,
          ),
        ).toBe(true);
        expect(leaf).toEqual({
          content: [{ type: "text", text: "[assistant reasoning omitted]" }],
          metadata: { reasoning: "unrelated metadata" },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
