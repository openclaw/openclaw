import { describe, expect, it } from "vitest";
import { extractFromNimSerializedContent } from "./pi-embedded-utils.js";

describe("extractFromNimSerializedContent", () => {
  it("extracts text from simple single-quoted NIM serialization", () => {
    const input = "[{'type': 'text', 'text': 'Hello world'}]";
    expect(extractFromNimSerializedContent(input)).toBe("Hello world");
  });

  it("extracts text from single-quoted NIM serialization with escaped quotes", () => {
    const input = "[{'type': 'text', 'text': 'It\\'s a test'}]";
    expect(extractFromNimSerializedContent(input)).toBe("It's a test");
  });

  it("extracts text from double-quoted NIM serialization", () => {
    const input = '[{"type": "text", "text": "Hello world"}]';
    expect(extractFromNimSerializedContent(input)).toBe("Hello world");
  });

  it("extracts and joins multiple text blocks", () => {
    const input = "[{'type': 'text', 'text': 'Part 1'}, {'type': 'text', 'text': 'Part 2'}]";
    expect(extractFromNimSerializedContent(input)).toBe("Part 1\nPart 2");
  });

  it("handles double nesting (Python style)", () => {
    const input = "[{'type': 'text', 'text': \"[{'type': 'text', 'text': 'Inner'}]\"}]";
    // Current implementation only does one pass
    expect(extractFromNimSerializedContent(input)).toBe("Inner");
  });

  it("handles triple nesting (User Reported Case)", () => {
    // simplified version of the user report with excessive escaping
    const input =
      "[{'type': 'text', 'text': \"[{'type': 'text', 'text': '[{\\\\\\'type\\\\\\': \\\\\\'text\\\\\\', \\\\\\'text\\\\\\': \\\\\\'Inner message\\\\\\'}]'}]\"}]";
    const result = extractFromNimSerializedContent(input);
    expect(result).toBe("Inner message");
  });

  it("returns original text if not starting with [{", () => {
    const input = "Just some text";
    expect(extractFromNimSerializedContent(input)).toBe("Just some text");
  });

  it("returns original text if missing type:text", () => {
    const input = "[{'type': 'other', 'data': 'value'}]";
    expect(extractFromNimSerializedContent(input)).toBe("[{'type': 'other', 'data': 'value'}]");
  });
});
