import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import transcriptSanitizeExtension from "./transcript-sanitize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function makeAssistantWithToolCall(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: {},
      },
    ],
    stopReason: "tool_use",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeAssistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * Minimal stub that captures the "context" event handler registered by
 * the extension and exposes it for testing.
 */
function createExtensionStub(): {
  handler:
    | ((event: ContextEvent, ctx: ExtensionContext) => { messages: AgentMessage[] } | undefined)
    | null;
  api: ExtensionAPI;
} {
  const stub: {
    handler:
      | ((event: ContextEvent, ctx: ExtensionContext) => { messages: AgentMessage[] } | undefined)
      | null;
    api: ExtensionAPI;
  } = {
    handler: null,
    api: {
      on(eventName: string, fn: (...args: unknown[]) => unknown) {
        if (eventName === "context") {
          stub.handler = fn as typeof stub.handler;
        }
      },
    } as unknown as ExtensionAPI,
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transcript-sanitize extension", () => {
  it("returns undefined when there are no orphaned tool_results", () => {
    const stub = createExtensionStub();
    transcriptSanitizeExtension(stub.api);
    expect(stub.handler).not.toBeNull();

    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistantWithToolCall("tc1", "exec"),
      makeToolResult({ toolCallId: "tc1", toolName: "exec", text: "ok" }),
      makeAssistantText("done"),
    ];

    const result = stub.handler!({ messages } as ContextEvent, {} as ExtensionContext);
    expect(result).toBeUndefined();
  });

  it("drops orphaned tool_result whose tool_use was compacted away", () => {
    const stub = createExtensionStub();
    transcriptSanitizeExtension(stub.api);

    // Simulate post-compaction state: the assistant message with tool_use was
    // summarized/dropped, leaving a dangling tool_result.
    const messages: AgentMessage[] = [
      makeUser("hello"),
      // tool_result WITHOUT a preceding assistant tool_use
      makeToolResult({ toolCallId: "tc1", toolName: "exec", text: "ok" }),
      makeAssistantText("done"),
    ];

    const result = stub.handler!({ messages } as ContextEvent, {} as ExtensionContext);
    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(2);
    // The orphaned tool_result should be gone
    expect(result!.messages.every((m) => (m as { role: string }).role !== "toolResult")).toBe(true);
  });

  it("adds synthetic tool_result for assistant tool_use with missing result", () => {
    const stub = createExtensionStub();
    transcriptSanitizeExtension(stub.api);

    // Assistant has tool_use but the result was lost (e.g. crash before tool completed)
    const messages: AgentMessage[] = [
      makeUser("run something"),
      makeAssistantWithToolCall("tc1", "exec"),
      // Missing tool_result for tc1
      makeUser("what happened?"),
      makeAssistantText("let me check"),
    ];

    const result = stub.handler!({ messages } as ContextEvent, {} as ExtensionContext);
    expect(result).toBeDefined();
    // Should have added a synthetic tool_result
    const toolResults = result!.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults.length).toBe(1);
  });

  it("handles multiple orphaned tool_results from heavy compaction", () => {
    const stub = createExtensionStub();
    transcriptSanitizeExtension(stub.api);

    // Multiple orphaned tool_results (simulating aggressive compaction)
    const messages: AgentMessage[] = [
      makeUser("start"),
      makeToolResult({ toolCallId: "tc1", toolName: "exec", text: "result 1" }),
      makeToolResult({ toolCallId: "tc2", toolName: "read", text: "result 2" }),
      makeToolResult({ toolCallId: "tc3", toolName: "write", text: "result 3" }),
      makeAssistantText("all done"),
    ];

    const result = stub.handler!({ messages } as ContextEvent, {} as ExtensionContext);
    expect(result).toBeDefined();
    // All 3 orphans should be dropped
    expect(result!.messages).toHaveLength(2); // user + assistant
  });

  it("drops orphaned tool_result whose tool_call_id already has a result", () => {
    const stub = createExtensionStub();
    transcriptSanitizeExtension(stub.api);

    // Place two tool_result blocks for the same call_id with a different assistant
    // in between. The second one has no preceding tool_use, so it is detected as
    // an orphan (droppedOrphanCount), not a duplicate.
    const messages: AgentMessage[] = [
      makeAssistantWithToolCall("tc1", "exec"),
      makeToolResult({ toolCallId: "tc1", toolName: "exec", text: "first" }),
      makeAssistantText("thinking..."),
      makeToolResult({ toolCallId: "tc1", toolName: "exec", text: "orphaned second" }),
      makeUser("done"),
    ] as AgentMessage[];

    const result = stub.handler!({ messages } as ContextEvent, {} as ExtensionContext);
    expect(result).toBeDefined();
    const toolResults = result!.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults.length).toBe(1);
  });

  it("is registered in buildEmbeddedExtensionFactories", async () => {
    const { buildEmbeddedExtensionFactories } = await import("../pi-embedded-runner/extensions.js");
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: {} as never,
      provider: "test",
      modelId: "test",
      model: undefined,
    });
    const mod = await import("./transcript-sanitize.js");
    expect(factories).toContain(mod.default);
  });
});
