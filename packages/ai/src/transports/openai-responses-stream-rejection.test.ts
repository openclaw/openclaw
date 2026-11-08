import type { Context } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { runAgentLoop } from "../../../agent-core/src/agent-loop.js";
import type { AgentTool } from "../../../agent-core/src/types.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { createAssistantOutput } from "./assistant-output.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { outputItem, wireCall } from "./openai-stream-cases.test-support.js";
import { failTransportStream } from "./transport-stream-shared.js";

const model = makeProviderModel("openai-responses", "openai", "test-responses");

it.each(["incomplete", "in_progress", "malformed"])(
  "settles an admitted async tool without starting later tools after %s rejection",
  async (rejection) => {
    const started = createDeferred();
    const release = createDeferred();
    const settled = vi.fn();
    const execute = vi.fn<AgentTool["execute"]>(async () => {
      started.resolve();
      await release.promise;
      settled();
      return { content: [], details: {} };
    });
    const response = createAssistantMessageEventStream();
    const output = { ...createAssistantOutput(model), timestamp: 0 };
    const tool = (index: number, args = "{}", status = "completed") => ({
      ...wireCall(String(index), "probe", args),
      status,
      async: true,
    });
    const wire = (async function* () {
      yield outputItem("done", tool(0));
      await started.promise;
      yield outputItem(
        "done",
        tool(1, '{"cut":', rejection === "malformed" ? "completed" : rejection),
        1,
      );
      yield outputItem("done", tool(2), 2);
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
    const agentTool: AgentTool = {
      name: "probe",
      label: "Probe",
      description: "Probe",
      parameters: Type.Object({}),
      execute,
    };
    const run = runAgentLoop(
      [{ role: "user", content: "probe", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [agentTool] },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      () => {},
      undefined,
      () => response,
    );
    response.push({ type: "start", partial: output });
    const processing = processResponsesStream(wire, output, response, model, {
      asyncToolExecution: true,
    }).catch((error: unknown) => failTransportStream({ stream: response, output, error }));
    try {
      await processing;
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
