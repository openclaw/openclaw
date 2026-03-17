import { describe, expect, it } from "vitest";
import { MockProvider } from "./mock.js";
function createWebhookContext(rawBody) {
  return {
    headers: {},
    rawBody,
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {}
  };
}
describe("MockProvider", () => {
  it("preserves explicit falsy event values", () => {
    const provider = new MockProvider();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          events: [
            {
              id: "evt-error",
              type: "call.error",
              callId: "call-1",
              timestamp: 0,
              error: "",
              retryable: false
            },
            {
              id: "evt-ended",
              type: "call.ended",
              callId: "call-2",
              reason: ""
            },
            {
              id: "evt-speech",
              type: "call.speech",
              callId: "call-3",
              transcript: "",
              isFinal: false
            }
          ]
        })
      )
    );
    expect(result.events).toEqual([
      {
        id: "evt-error",
        type: "call.error",
        callId: "call-1",
        providerCallId: void 0,
        timestamp: 0,
        error: "",
        retryable: false
      },
      {
        id: "evt-ended",
        type: "call.ended",
        callId: "call-2",
        providerCallId: void 0,
        timestamp: expect.any(Number),
        reason: ""
      },
      {
        id: "evt-speech",
        type: "call.speech",
        callId: "call-3",
        providerCallId: void 0,
        timestamp: expect.any(Number),
        transcript: "",
        isFinal: false,
        confidence: void 0
      }
    ]);
  });
});
