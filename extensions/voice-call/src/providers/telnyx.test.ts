import { describe, expect, it } from "vitest";

import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

function createProvider(): TelnyxProvider {
  return new TelnyxProvider({
    apiKey: "KEY123",
    connectionId: "conn-123",
  });
}

function createContext(payload: object): WebhookContext {
  return {
    headers: {},
    rawBody: JSON.stringify({ data: payload }),
    url: "https://example.com/voice/telnyx",
    method: "POST",
  };
}

describe("TelnyxProvider", () => {
  describe("parseWebhookEvent", () => {
    it("parses direction as inbound for incoming calls", () => {
      const provider = createProvider();
      const ctx = createContext({
        id: "evt-1",
        event_type: "call.initiated",
        payload: {
          call_control_id: "ctrl-1",
          direction: "incoming",
          from: "+15551234567",
          to: "+15559876543",
        },
      });

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "call.initiated",
        direction: "inbound",
        from: "+15551234567",
        to: "+15559876543",
      });
    });

    it("parses direction as outbound for outgoing calls", () => {
      const provider = createProvider();
      const ctx = createContext({
        id: "evt-2",
        event_type: "call.initiated",
        payload: {
          call_control_id: "ctrl-2",
          direction: "outgoing",
          from: "+15559876543",
          to: "+15551234567",
        },
      });

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "call.initiated",
        direction: "outbound",
        from: "+15559876543",
        to: "+15551234567",
      });
    });

    it("handles missing direction gracefully", () => {
      const provider = createProvider();
      const ctx = createContext({
        id: "evt-3",
        event_type: "call.answered",
        payload: {
          call_control_id: "ctrl-3",
        },
      });

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "call.answered",
        direction: undefined,
      });
    });

    it("decodes callId from Base64 client_state", () => {
      const provider = createProvider();
      const callId = "my-call-123";
      const ctx = createContext({
        id: "evt-4",
        event_type: "call.ringing",
        payload: {
          call_control_id: "ctrl-4",
          client_state: Buffer.from(callId).toString("base64"),
          direction: "incoming",
        },
      });

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        callId: "my-call-123",
        direction: "inbound",
      });
    });
  });
});
