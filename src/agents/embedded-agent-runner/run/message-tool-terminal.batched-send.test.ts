import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";
import {
  createTerminalTestModel,
  terminalResponse,
  terminalToolCall,
} from "./message-tool-terminal.test-support.js";

function terminalMessageAgent(
  tools: AgentTool[],
  step: (request: number) => ReturnType<typeof terminalResponse>,
) {
  const counts = { requests: 0, deliveries: 0 };
  const agent = new Agent({
    initialState: { model: createTerminalTestModel(), tools },
    streamFn: () => step(++counts.requests),
  });
  installMessageToolTerminalHook({
    agent,
    sourceReplyDeliveryMode: "automatic",
    onDeliveredSourceReply: () => {
      counts.deliveries += 1;
    },
  });
  return { agent, counts };
}

function sourceReplyMessageTool(onExecute: () => void = () => {}): AgentTool {
  return {
    name: "message",
    label: "Message",
    description: "Reply to the current source",
    parameters: Type.Object({ action: Type.String(), message: Type.String() }),
    execute: async () => {
      onExecute();
      return {
        content: [],
        details: {
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
          sourceReplyRoute: "current-source",
        },
      };
    },
  };
}

describe("message send batched with other tool calls", () => {
  it("returns sibling results to the model when a send omits final next to other work", async () => {
    const executed: string[] = [];
    const seenByModel: string[] = [];
    const run = terminalMessageAgent(
      [
        sourceReplyMessageTool(() => executed.push("message")),
        {
          name: "read",
          label: "Read",
          description: "Read a file",
          parameters: Type.Object({}),
          execute: async () => {
            executed.push("read");
            return { content: [{ type: "text", text: "skill contents" }], details: {} };
          },
        },
      ],
      (requests) => {
        if (requests === 1) {
          return terminalResponse(
            [
              terminalToolCall("message", "ack", {
                action: "send",
                message: "Understood, checking now.",
              }),
              terminalToolCall("read", "read-skill"),
            ],
            "toolUse",
          );
        }
        seenByModel.push(
          ...run.agent.state.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => message.toolName),
        );
        return terminalResponse([{ type: "text", text: "Here is the result." }], "stop");
      },
    );

    await run.agent.prompt("Check the invoices and report back.");

    expect({ executed, ...run.counts, seenByModel }).toEqual({
      executed: ["message", "read"],
      deliveries: 1,
      requests: 2,
      seenByModel: ["message", "read"],
    });
  });

  it("still ends the turn when a send that omits final is the message's only work", async () => {
    const run = terminalMessageAgent([sourceReplyMessageTool()], () =>
      terminalResponse(
        [terminalToolCall("message", "answer", { action: "send", message: "Done." })],
        "toolUse",
      ),
    );

    await run.agent.prompt("Answer briefly.");

    expect(run.counts).toEqual({ requests: 1, deliveries: 1 });
  });
});
