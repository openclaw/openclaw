// Qa Lab tests cover Slack live adapter message reconciliation.
import { describe, expect, it } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { testing } from "./adapter.runtime.js";

describe("Slack live adapter reconciliation", () => {
  it("records streamed updates to the same Slack timestamp as bus edits", async () => {
    const state = createQaBusState();
    const busMessageIds = new Map<string, string>();
    const observedText = new Map<string, string>();
    const messages: Parameters<typeof testing.recordSlackObservedMessage>[0]["messages"] = {
      addInboundMessage: (input) => state.addInboundMessage(input),
      addOutboundMessage: (input) => state.addOutboundMessage(input),
      editMessage: (input) => state.editMessage(input),
    };
    const base = {
      accountId: "sut",
      busMessageIds,
      logicalConversationId: "C123",
      messages,
      observedText,
      sutUserId: "U123",
    };

    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-", ts: "123.000001", user: "U123" },
    });
    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-CHANNEL-BASELINE-OK", ts: "123.000001", user: "U123" },
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe("QA-CHANNEL-BASELINE-OK");
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "outbound-message",
      "message-edited",
    ]);
  });
});
