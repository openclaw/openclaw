import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  isAllowedParsedChatSender: vi.fn(),
  parseChatAllowTargetPrefixes: vi.fn(),
  parseChatTargetPrefixesOrThrow: vi.fn(),
  resolveServicePrefixedAllowTarget: vi.fn(),
  resolveServicePrefixedTarget: vi.fn(),
}));

import { normalizeWebhookMessage } from "./monitor-normalize.js";

function makePayload(fields: Record<string, unknown>) {
  return {
    data: {
      handle: { id: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      ...fields,
    },
  };
}

describe("normalizeWebhookMessage subject handling", () => {
  it("combines subject and text when both are present", () => {
    const result = normalizeWebhookMessage(
      makePayload({ text: "body text", subject: "Subject line" }),
    );
    expect(result?.text).toBe("Subject line\nbody text");
  });

  it("uses subject alone when text is absent", () => {
    const result = normalizeWebhookMessage(makePayload({ subject: "Subject only" }));
    expect(result?.text).toBe("Subject only");
  });

  it("uses text alone when subject is absent", () => {
    const result = normalizeWebhookMessage(makePayload({ text: "Text only" }));
    expect(result?.text).toBe("Text only");
  });

  it("falls back to body field when text is absent", () => {
    const result = normalizeWebhookMessage(makePayload({ body: "Body field" }));
    expect(result?.text).toBe("Body field");
  });

  it("combines subject with body field when text is absent", () => {
    const result = normalizeWebhookMessage(
      makePayload({ body: "Body field", subject: "Subject line" }),
    );
    expect(result?.text).toBe("Subject line\nBody field");
  });

  it("returns empty text when no text, body, or subject", () => {
    const result = normalizeWebhookMessage(makePayload({}));
    expect(result?.text).toBe("");
  });
});
