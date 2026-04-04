import { describe, expect, it } from "vitest";
import { extractMessageText } from "./message-content.js";

describe("extractMessageText", () => {
  it("extracts text-bearing array blocks across supported block types", () => {
    expect(
      extractMessageText([
        { type: "input_text", text: "Input block" },
        { type: "output_text", text: "Output block" },
        { type: "text", text: "Plain text block" },
      ]),
    ).toBe("Input block\nOutput block\nPlain text block");
  });

  it("extracts standalone text-bearing objects", () => {
    expect(extractMessageText({ type: "output_text", text: "Standalone output" })).toBe(
      "Standalone output",
    );
  });

  it("extracts object-form text payloads", () => {
    expect(
      extractMessageText({
        type: "input_text",
        text: { value: "Structured text payload" },
      }),
    ).toBe("Structured text payload");
  });
});
