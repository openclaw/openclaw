import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { runAgentLoop } from "../../../agent-core/src/agent-loop.js";
import type { AgentTool } from "../../../agent-core/src/types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { failTransportStream } from "./transport-stream-shared.js";

const model: Model = {
  id: "test-responses",
  name: "Test Responses",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

it.each(["incomplete", "in_progress", "malformed"])(
  "settles an admitted async tool without starting later tools after %s rejection",
  async (rejection) => {
    const started = createDeferred();
    const release = createDeferred();
    const drained = createDeferred();
    const settled = vi.fn();
    const execute = vi.fn<AgentTool["execute"]>(async () => {
      started.resolve();
      await release.promise;
      settled();
      return { content: [], details: {} };
    });
    const response = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createZeroUsage(),
      stopReason: "stop",
      timestamp: 0,
    };
    const tool = (index: number) => ({
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name: "probe",
      arguments: "{}",
      status: "completed",
      async: true,
    });
    const wire = (async function* () {
      yield { type: "response.output_item.done", output_index: 0, item: tool(0) };
      await started.promise;
      yield {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          ...tool(1),
          status: rejection === "malformed" ? "completed" : rejection,
          arguments: '{"cut":',
        },
      };
      yield { type: "response.output_item.done", output_index: 2, item: tool(2) };
      yield {
        type: "response.incomplete",
        response: {
          id: "resp_drained",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [tool(0), tool(1), tool(2)],
          usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29 },
        },
      };
    })();
    const run = runAgentLoop(
      [{ role: "user", content: "probe", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "probe",
            label: "Probe",
            description: "Probe",
            parameters: Type.Object({}),
            execute,
          },
        ],
      },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      () => {},
      undefined,
      () => response,
    );
    response.push({ type: "start", partial: output });
    const processing = processResponsesStream(wire, output, response, model, {
      asyncToolExecution: true,
    })
      .catch((error: unknown) => failTransportStream({ stream: response, output, error }))
      .finally(() => drained.resolve());
    try {
      await drained.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(output.usage.totalTokens).toBe(29);
      expect(output.errorCode).toBe(
        rejection === "malformed" ? "malformed_tool_call_arguments" : "incomplete_tool_call",
      );
      release.resolve();
      const messages = await run;
      expect(settled).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
        { toolCallId: "call_0|fc_0", isError: false },
      ]);
    } finally {
      release.resolve();
      await processing;
      response.end();
      await run;
    }
  },
);
