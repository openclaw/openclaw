import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession late tool_execution_end after unsubscribe", () => {
  it("commits media URLs from tool result when unsubscribe fires before tool-end", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-late-media",
    });

    // Start a messaging send tool with no media in args (no pendingMediaUrls).
    // Media will only appear in the tool result, so isMessagingSend detection
    // relies on startArgs from toolStartData to identify this as a send action.
    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-late-media",
      args: { action: "send", to: "+1555", content: "hi" },
    });
    await Promise.resolve();

    // Simulate timeout/abort: unsubscribe fires before the tool-end event.
    subscription.unsubscribe();

    // Late tool-end arrives with media URLs in the result payload.
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-late-media",
      isError: false,
      result: {
        content: [{ type: "text", text: JSON.stringify({ mediaUrls: ["file:///result.jpg"] }) }],
      },
    });
    await Promise.resolve();

    expect(subscription.getMessagingToolSentMediaUrls()).toContain("file:///result.jpg");
  });
});
