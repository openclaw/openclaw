import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import improvementsIntegrationExtension from "./improvements-integration.js";

describe("improvementsIntegrationExtension", () => {
  it("microcompacts older tool results during session_before_compact", async () => {
    let handler:
      | ((
          event: { preparation: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[] } },
          ctx: Record<string, unknown>,
        ) => Promise<void>)
      | undefined;

    improvementsIntegrationExtension({
      on(eventName, cb) {
        if (eventName === "session_before_compact") {
          handler = cb as typeof handler;
        }
      },
    } as never);

    expect(handler).toBeTypeOf("function");

    const makeToolResult = (idx: number): AgentMessage => ({
      role: "toolResult",
      toolCallId: `read-${idx}`,
      toolName: "read",
      content: [{ type: "text", text: String.fromCharCode(65 + idx).repeat(3000) }],
      details: { idx },
      isError: false,
      timestamp: idx + 1,
    });

    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: [{ type: "text", text: "read files" }], timestamp: 0 } as AgentMessage,
          makeToolResult(0),
          makeToolResult(1),
          makeToolResult(2),
          makeToolResult(3),
        ],
        turnPrefixMessages: [],
      },
    };

    await handler!(event, {});

    const firstToolResult = event.preparation.messagesToSummarize[1] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    const lastToolResult = event.preparation.messagesToSummarize[4] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };

    expect(firstToolResult.role).toBe("toolResult");
    expect(firstToolResult.content[0]?.text).toContain("[Tool Result: read");
    expect(lastToolResult.content[0]?.text).toHaveLength(3000);
  });
});
