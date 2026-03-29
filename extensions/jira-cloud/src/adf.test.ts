import { describe, expect, it } from "vitest";
import { toMinimalAdfTextDocument } from "./adf.js";

describe("adf helper", () => {
  it("converts plain text into minimal adf document", () => {
    expect(toMinimalAdfTextDocument("Hello Jira")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello Jira" }],
        },
      ],
    });
  });

  it("splits non-empty lines into paragraphs", () => {
    const doc = toMinimalAdfTextDocument("line 1\n\nline 2");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[1]?.content[0]?.text).toBe("line 2");
  });
});

