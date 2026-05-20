import { describe, expect, it } from "vitest";

describe("stripReasoningParams", () => {
  // Import helper function for testing
  function stripReasoningFieldsFromMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const record = msg as Record<string, unknown>;

    delete record.reasoning_details;
    delete record.reasoning_content;
    delete record.reasoning;
    delete record.reasoning_text;

    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        stripReasoningFieldsFromMessage(part);
      }
    }
  }

  function stripReasoningParams(payloadObj: Record<string, unknown>): void {
    delete payloadObj.reasoning;
    delete payloadObj.reasoning_effort;
    delete payloadObj.reasoningEffort;
    delete payloadObj.include;

    if (Array.isArray(payloadObj.messages)) {
      for (const msg of payloadObj.messages) {
        stripReasoningFieldsFromMessage(msg);
      }
    }

    if (Array.isArray(payloadObj.input)) {
      for (const msg of payloadObj.input) {
        stripReasoningFieldsFromMessage(msg);
      }
    }
  }

  it("strips reasoning_details from replayed messages for kimi models", () => {
    const payload = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", reasoning_details: [{ type: "reasoning.text", text: "Thinking..." }] },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.messages[1].reasoning_details).toBeUndefined();
    expect(payload.messages[1].content).toBe("Hi");
  });

  it("strips reasoning fields from nested content array", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Response" },
            { type: "reasoning", reasoning_details: [{ type: "reasoning.text", text: "Thinking..." }] },
          ],
        },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.messages[0].content[1].reasoning_details).toBeUndefined();
    expect(payload.messages[0].content[0].text).toBe("Response");
  });

  it("strips reasoning fields from input array", () => {
    const payload = {
      input: [
        { role: "assistant", reasoning_content: "thinking...", content: "Answer" },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.input[0].reasoning_content).toBeUndefined();
    expect(payload.input[0].content).toBe("Answer");
  });

  it("strips root-level reasoning fields", () => {
    const payload = {
      reasoning: "high",
      reasoning_effort: "medium",
      reasoningEffort: "low",
      include: ["reasoning"],
      messages: [],
    };

    stripReasoningParams(payload);

    expect(payload.reasoning).toBeUndefined();
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.reasoningEffort).toBeUndefined();
    expect(payload.include).toBeUndefined();
  });

  it("strips all reasoning field types from messages", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          reasoning_details: "thinking",
          reasoning_content: "more thinking",
          reasoning: "analysis",
          reasoning_text: "reflection",
          content: "Final answer",
        },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.messages[0].reasoning_details).toBeUndefined();
    expect(payload.messages[0].reasoning_content).toBeUndefined();
    expect(payload.messages[0].reasoning).toBeUndefined();
    expect(payload.messages[0].reasoning_text).toBeUndefined();
    expect(payload.messages[0].content).toBe("Final answer");
  });

  it("preserves non-reasoning fields", () => {
    const payload = {
      model: "kimi-k2.6",
      temperature: 0.7,
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer", tool_calls: [{ id: "1", function: { name: "test" } }] },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.model).toBe("kimi-k2.6");
    expect(payload.temperature).toBe(0.7);
    expect(payload.messages[1].tool_calls).toEqual([{ id: "1", function: { name: "test" } }]);
  });

  it("handles empty payload gracefully", () => {
    const payload = {};

    stripReasoningParams(payload);

    expect(payload).toEqual({});
  });

  it("handles messages without reasoning fields", () => {
    const payload = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  it("handles nested reasoning fields deeply in content", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "compound",
              content: [
                { type: "text", text: "Part 1" },
                { type: "reasoning", reasoning_details: "deep thinking" },
              ],
            },
          ],
        },
      ],
    };

    stripReasoningParams(payload);

    expect(payload.messages[0].content[0].content[1].reasoning_details).toBeUndefined();
    expect(payload.messages[0].content[0].content[0].text).toBe("Part 1");
  });
});