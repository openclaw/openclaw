import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@openclaw/llm-core";
import OpenAI from "openai";
import { expect, it } from "vitest";
import { Agent } from "../../packages/agent-core/src/agent.js";
import {
  createAiTransportHost,
  getAiTransportHost,
  runWithAiTransportHost,
} from "../../packages/ai/src/host.js";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { isOpenAIResponsesCompactionOutput } from "../../packages/ai/src/transports/openai-responses-compaction-window.js";
import { createOpenAIResponsesContextManagementWrapper } from "../llm/providers/stream-wrappers/openai.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

const apiKey = process.env.OPENAI_API_KEY ?? "";
const live = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey ? it : it.skip;

live(
  "recovers a stored compaction checkpoint on the next agent turn and after reload",
  async () => {
    const model = makeProviderModel(
      "openai-responses",
      "openai",
      process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna",
      { baseUrl: "https://api.openai.com/v1", maxTokens: 512 },
    );
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    const sessionId = randomUUID();
    const marker = `QUARTZ-${randomUUID().slice(0, 8)}`;
    const compact = await client.responses.compact({
      model: model.id,
      input: [
        { role: "user", content: "Remember the marker from the lookup tool." },
        { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_lookup", output: marker },
        { role: "assistant", content: "Remembered." },
      ],
    });
    const output: unknown = compact.output;
    if (!isOpenAIResponsesCompactionOutput(output, model)) {
      throw new Error("Invalid compaction window");
    }
    const checkpoint = output.find((item) => item.type === "compaction");
    expect(checkpoint).toBeDefined();
    if (!checkpoint) {
      throw new Error("Missing compaction checkpoint");
    }
    const saved = makeAssistantMessageFixture({
      model: model.id,
      content: [],
      stopReason: "stop",
      errorMessage: undefined,
    });
    captureOpenAIResponsesCompaction(
      saved,
      checkpoint,
      "retained-users",
      model,
      buildOpenAIResponsesReasoningReplayMetadata(model, { sessionId }),
      output,
    );
    const serialized = JSON.stringify(saved);
    const storedIds: string[] = [];
    try {
      // Establish the old wire contract's first success, then its deterministic failure.
      const wireOutput = compact.output;
      if (!wireOutput.every((item) => item.type === "message" || item.type === "compaction")) {
        throw new Error("Unexpected compact endpoint output item");
      }
      const input = [...wireOutput, { role: "user" as const, content: "Reply exactly ACK." }];
      for (const attempt of [0, 1]) {
        const stream = await client.responses.create({
          model: model.id,
          input,
          store: true,
          stream: true,
          reasoning: { effort: "low" },
          max_output_tokens: 256,
        });
        let conflict = false;
        try {
          for await (const event of stream) {
            if (event.type === "response.completed") {
              storedIds.push(event.response.id);
            }
          }
        } catch (error) {
          if (!(error instanceof OpenAI.APIError) || error.code !== "item_conflict") {
            throw error;
          }
          conflict = true;
        }
        expect(conflict).toBe(attempt === 1);
      }
      expect(storedIds).toHaveLength(1);
      for (let reload = 0; reload < 2; reload++) {
        cleanupSessionResources();
        const agent = new Agent({
          initialState: {
            model,
            messages: [JSON.parse(serialized) as AssistantMessage],
            thinkingLevel: "low",
          },
          sessionId,
          transport: "sse",
          getApiKey: () => apiKey,
          streamFn: createOpenAIResponsesContextManagementWrapper(
            createOpenAIResponsesTransportStreamFn(),
            undefined,
          ),
        });
        const requests: Array<Record<string, unknown>> = [];
        const originalHost = getAiTransportHost();
        const host = createAiTransportHost({
          ...originalHost,
          buildModelFetch: (...args) => {
            const fetcher = originalHost.buildModelFetch(...args) ?? globalThis.fetch;
            return async (url, init) => {
              requests.push(await new Request(url, init).json());
              return fetcher(url, init);
            };
          },
        });
        await runWithAiTransportHost(host, async () => {
          await agent.prompt("Reply exactly with the marker from the lookup tool.");
          await agent.prompt("Repeat that marker, with no other text.");
        });
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.store).toBe(false);
          expect(request).not.toHaveProperty("previous_response_id");
          expect(JSON.stringify(request.input)).toContain(checkpoint.encrypted_content);
        }
        const answers = agent.state.messages
          .filter((message) => message.role === "assistant")
          .slice(1);
        expect(answers).toHaveLength(2);
        for (const answer of answers) {
          if (answer.role !== "assistant") {
            throw new Error("Missing assistant response");
          }
          expect(answer.stopReason, answer.errorCode ?? answer.errorMessage).toBe("stop");
          expect(
            answer.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
              .trim(),
          ).toBe(marker);
        }
      }
    } finally {
      cleanupSessionResources();
      for (const id of storedIds) {
        await client.responses.delete(id);
      }
    }
  },
  180_000,
);
