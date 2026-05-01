/**
 * redaction-hook.test.ts — defense-in-depth before_message_write hook tests.
 *
 * The key adversarial test: a fabricated assistant message with a real PAN
 * in toolCall.arguments MUST be blocked. This proves defense-in-depth works.
 */

import { describe, expect, it } from "vitest";
import { scanMessageForCardData } from "./redaction-hook.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMessage(content: unknown[]) {
  return { role: "assistant", content };
}

function makeToolCallBlock(args: unknown, type: "toolCall" | "tool_use" = "toolCall") {
  if (type === "toolCall") {
    return { type: "toolCall", arguments: args };
  }
  return { type: "tool_use", input: args };
}

function makeEvent(message: unknown) {
  return { message } as any;
}

// ---------------------------------------------------------------------------
// Non-assistant messages — passthrough
// ---------------------------------------------------------------------------

describe("redaction hook — non-assistant messages", () => {
  it("returns undefined for a user message", () => {
    const result = scanMessageForCardData(
      makeEvent({ role: "user", content: [{ type: "text", text: "Hello" }] }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for a tool message", () => {
    const result = scanMessageForCardData(
      makeEvent({ role: "tool", content: [{ type: "text", text: "result" }] }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when message is null", () => {
    const result = scanMessageForCardData(makeEvent(null));
    expect(result).toBeUndefined();
  });

  it("returns undefined when message is undefined", () => {
    const result = scanMessageForCardData(makeEvent(undefined));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Messages without toolCall blocks — passthrough
// ---------------------------------------------------------------------------

describe("redaction hook — messages without toolCall blocks", () => {
  it("returns undefined for assistant message with only text blocks", () => {
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([{ type: "text", text: "I will fill the form now." }])),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for assistant message with empty content array", () => {
    const result = scanMessageForCardData(makeEvent(makeAssistantMessage([])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when content is not an array", () => {
    const result = scanMessageForCardData(makeEvent({ role: "assistant", content: "raw string" }));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No card data — passthrough
// ---------------------------------------------------------------------------

describe("redaction hook — no card data in toolCall args", () => {
  it("returns undefined when toolCall arguments contain no card-shaped data", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            request: {
              kind: "fill",
              fields: [
                { ref: "name", type: "text", value: "John Doe" },
                { ref: "email", type: "email", value: "john@example.com" },
              ],
            },
          }),
        ]),
      ),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when toolCall arguments are empty", () => {
    const result = scanMessageForCardData(makeEvent(makeAssistantMessage([makeToolCallBlock({})])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when toolCall arguments are null", () => {
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([{ type: "toolCall", arguments: null }])),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FillSentinel in arguments — NOT a real PAN, should pass through
// ---------------------------------------------------------------------------

describe("redaction hook — FillSentinel in arguments is not card-shaped", () => {
  it("returns undefined when toolCall arguments contain a FillSentinel (not a PAN)", () => {
    // The sentinel has $paymentHandle and field — not Luhn-valid digits
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            request: {
              kind: "fill",
              fields: [
                {
                  ref: "pan",
                  type: "text",
                  value: { $paymentHandle: "handle-abc-123", field: "pan" },
                },
              ],
            },
          }),
        ]),
      ),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PAN detection — MUST block
// ---------------------------------------------------------------------------

describe("redaction hook — PAN detection blocks the message", () => {
  it("blocks when a Luhn-valid 16-digit PAN appears in toolCall arguments", () => {
    // Adversarial test: literal PAN value that should NEVER reach the transcript
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            request: {
              kind: "fill",
              fields: [{ ref: "pan", type: "text", value: "4242424242424242" }],
            },
          }),
        ]),
      ),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("blocks when PAN appears with spaces (4242 4242 4242 4242)", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            request: {
              kind: "fill",
              fields: [{ ref: "pan", type: "text", value: "4242 4242 4242 4242" }],
            },
          }),
        ]),
      ),
    );
    expect(result!.block).toBe(true);
  });

  it("blocks when PAN appears nested in arbitrary object structure", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            someArbitraryNested: {
              deeply: { nested: { pan: "4242424242424242" } },
            },
          }),
        ]),
      ),
    );
    expect(result!.block).toBe(true);
  });

  it("blocks for a tool_use block (Anthropic-style) with PAN in input", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock(
            { request: { kind: "fill", fields: [{ value: "4242424242424242" }] } },
            "tool_use",
          ),
        ]),
      ),
    );
    expect(result!.block).toBe(true);
  });

  it("blocks when a different Luhn-valid PAN appears (Mastercard)", () => {
    // 5500005555555559 — valid Luhn Mastercard test number
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([makeToolCallBlock({ cardNumber: "5500005555555559" })])),
    );
    expect(result!.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Embedded PAN detection — MUST block (Fix 3)
// ---------------------------------------------------------------------------

describe("redaction hook — embedded PAN in toolCall arguments blocks message", () => {
  it("blocks when a PAN is embedded in an error-message-like string", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            "toolCall.arguments.note": "Card 4242424242424242 declined",
          }),
        ]),
      ),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("blocks when a dash-separated PAN appears in toolCall arguments", () => {
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([makeToolCallBlock({ cardNumber: "4242-4242-4242-4242" })])),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CVV detection — MUST block in CVV-key context
// ---------------------------------------------------------------------------

describe("redaction hook — CVV detection in CVV-key context", () => {
  it("blocks when cvv key holds a 3-digit value", () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            request: {
              kind: "fill",
              fields: [{ ref: "cvv", type: "password", cvv: "123" }],
            },
          }),
        ]),
      ),
    );
    expect(result!.block).toBe(true);
  });

  it("blocks when cvc key holds a 3-digit value", () => {
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([makeToolCallBlock({ cvc: "456" })])),
    );
    expect(result!.block).toBe(true);
  });

  it("does NOT block for a non-CVV 3-digit number in a random key", () => {
    const result = scanMessageForCardData(
      makeEvent(makeAssistantMessage([makeToolCallBlock({ quantity: "123" })])),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Authorization: Payment header detection — MUST block
// ---------------------------------------------------------------------------

describe("Authorization: Payment header detection", () => {
  it("blocks toolCall arguments containing { authorization: 'Payment <token>' }", async () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            headers: { authorization: "Payment spt_test_abc123def456" },
          }),
        ]),
      ),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("blocks Authorization (capitalized) variant", async () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            headers: { Authorization: "Payment spt_live_xyz789" },
          }),
        ]),
      ),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("does NOT block non-Payment Authorization headers", async () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
          }),
        ]),
      ),
    );
    expect(result).toBeUndefined();
  });

  it("does NOT block 'Payment' as a plain string outside an authorization key", async () => {
    const result = scanMessageForCardData(
      makeEvent(
        makeAssistantMessage([
          makeToolCallBlock({
            description: "Payment for goods",
          }),
        ]),
      ),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registration wiring
// ---------------------------------------------------------------------------

describe("registerRedactionHook registration", () => {
  it("calls api.on with 'before_message_write'", async () => {
    const { registerRedactionHook } = await import("./redaction-hook.js");
    let capturedHookName: string | null = null;
    const fakeApi = {
      on: (hookName: string, _handler: unknown) => {
        capturedHookName = hookName;
      },
    };
    registerRedactionHook(fakeApi as any);
    expect(capturedHookName).toBe("before_message_write");
  });
});
