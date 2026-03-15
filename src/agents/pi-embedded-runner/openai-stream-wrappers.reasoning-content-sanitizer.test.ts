import { describe, expect, it } from "vitest";
import { createReasoningContentSanitizer } from "./openai-stream-wrappers.js";

/**
 * Minimal stub that captures the payload after the sanitizer runs.
 * We intercept via onPayload to inspect the sanitized result.
 */
function capturePayload(
  model: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;

  // Create a fake base stream function that invokes onPayload and captures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeBase = (_m: unknown, _ctx: unknown, options?: { onPayload?: Function }): any => {
    const payload = { model: model.id, messages: structuredClone(messages) };
    options?.onPayload?.(payload);
    captured = payload;
    // Return a minimal async iterable to satisfy the StreamFn contract.
    return (async function* () {})();
  };

  const wrapped = createReasoningContentSanitizer(fakeBase as never);
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  wrapped(model as never, { messages } as never, undefined);

  if (!captured) {
    throw new Error("payload was not captured");
  }
  return captured;
}

describe("createReasoningContentSanitizer", () => {
  it("strips null bytes from reasoning_content", () => {
    const payload = capturePayload({ id: "qwen-3.5" }, [
      { role: "assistant", content: "hi", reasoning_content: "think\x00ing" },
    ]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];
    expect(msg.reasoning_content).toBe("thinking");
  });

  it("strips C0 control characters but preserves tab, newline, carriage return", () => {
    const payload = capturePayload({ id: "qwen-3.5" }, [
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "line1\nline2\ttab\rreturn\x01bell\x07esc\x1B",
      },
    ]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];
    expect(msg.reasoning_content).toBe("line1\nline2\ttab\rreturnbellesc");
  });

  it("strips DEL character (0x7F)", () => {
    const payload = capturePayload({ id: "test" }, [
      { role: "assistant", content: "", reasoning_content: "before\x7Fafter" },
    ]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];
    expect(msg.reasoning_content).toBe("beforeafter");
  });

  it("sanitizes all three reasoning field names", () => {
    const payload = capturePayload({ id: "test" }, [
      { role: "assistant", content: "", reasoning_content: "a\x00b" },
      { role: "assistant", content: "", reasoning: "c\x01d" },
      { role: "assistant", content: "", reasoning_text: "e\x02f" },
    ]);
    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].reasoning_content).toBe("ab");
    expect(msgs[1].reasoning).toBe("cd");
    expect(msgs[2].reasoning_text).toBe("ef");
  });

  it("does not modify clean reasoning_content", () => {
    const original = "This is clean reasoning with newlines\nand tabs\t.";
    const payload = capturePayload({ id: "test" }, [
      { role: "assistant", content: "hi", reasoning_content: original },
    ]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];
    expect(msg.reasoning_content).toBe(original);
  });

  it("does not modify user messages", () => {
    const payload = capturePayload({ id: "test" }, [{ role: "user", content: "hello\x00world" }]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toBe("hello\x00world");
  });

  it("handles messages without reasoning fields", () => {
    const payload = capturePayload({ id: "test" }, [
      { role: "assistant", content: "just text" },
      { role: "user", content: "question" },
    ]);
    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe("just text");
    expect(msgs[1].content).toBe("question");
  });

  it("produces JSON-serializable output from problematic reasoning_content", () => {
    // Simulate the exact scenario: reasoning content with control characters
    // that would cause oMLX to reject the JSON body.
    const problematic =
      "Let me think about this...\x00\x01\x02\x03\x04\x05\x06\x07\x08" +
      "\x0B\x0C\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A" +
      "\x1B\x1C\x1D\x1E\x1F\x7F...done";
    const payload = capturePayload({ id: "qwen-3.5" }, [
      { role: "assistant", content: "", reasoning_content: problematic },
    ]);
    const msg = (payload.messages as Array<Record<string, unknown>>)[0];

    // Verify the result is clean.
    expect(msg.reasoning_content).toBe("Let me think about this......done");

    // Verify JSON round-trip works cleanly.
    const json = JSON.stringify(payload);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
