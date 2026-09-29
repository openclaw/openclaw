import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("nested lists", () => {
  it("records parser-owned item spans and list ancestry", () => {
    const result = markdownToIR("- parent\n  - child\n- next\n# Heading");
    const items = [...(result.listItems ?? [])].toSorted(
      (left, right) => (left.listMarker?.start ?? 0) - (right.listMarker?.start ?? 0),
    );
    const [parent, child, next] = items;
    expect(items).toHaveLength(3);
    expect(parent).toMatchObject({ depth: 0, start: 0 });
    expect(child).toMatchObject({ depth: 1, parentListId: parent?.listId });
    expect(next?.listId).toBe(parent?.listId);
    expect(result.text.slice(parent?.start, parent?.end)).toContain("child");
    expect(result.text.slice(next?.start, next?.end)).not.toContain("Heading");
  });

  it("keeps loose continuation paragraphs inside the item span", () => {
    const result = markdownToIR("- first\n\n  continuation\n- next");
    const first = result.listItems?.find((item) => item.listMarker?.start === 0);
    expect(result.text.slice(first?.start, first?.end)).toContain("continuation");
  });

  it.each([
    [
      "ordered numbering at each depth",
      "1. First\n   1. Sub-first\n   2. Sub-second\n2. Second",
      "1. First\n  1. Sub-first\n  2. Sub-second\n2. Second",
    ],
    [
      "bullet depth and sibling transitions",
      "- A1\n  - B1\n    - C1\n    - C2\n  - B2\n- A2",
      "• A1\n  • B1\n    • C1\n    • C2\n  • B2\n• A2",
    ],
    [
      "bullet > ordered > bullet",
      "- Bullet 1\n  1. Ordered 1.1\n     - Deep bullet\n  2. Ordered 1.2\n- Bullet 2",
      "• Bullet 1\n  1. Ordered 1.1\n    • Deep bullet\n  2. Ordered 1.2\n• Bullet 2",
    ],
    [
      "ordered > bullet > ordered",
      "1. First\n   - Sub bullet\n     1. Deep ordered\n   - Another bullet\n2. Second",
      "1. First\n  • Sub bullet\n    1. Deep ordered\n  • Another bullet\n2. Second",
    ],
    ["sibling nested lists", "- A\n  - A1\n- B\n  - B1", "• A\n  • A1\n• B\n  • B1"],
  ])("renders %s", (_name, markdown, expected) => {
    expect(markdownToIR(markdown).text).toBe(expected);
  });

  it("handles empty parent with nested items", () => {
    expect(markdownToIR("-\n  - Nested only\n- Normal").text).toContain("  • Nested only");
  });
});

describe("list paragraph spacing", () => {
  it.each([
    [
      "prose before a fence in a tight item",
      "- Run this:\n  ```sh\n  echo hello\n  ```\n- Done",
      "• Run this:\necho hello\n• Done",
    ],
    [
      "headings and paragraphs in a tight ordered item",
      "1. Intro\n   # Heading\n   Details\n2. Done",
      "1. Intro\nHeading\n\nDetails\n2. Done",
    ],
    [
      "paragraphs inside a list-owned quote",
      "- > First paragraph\n  >\n  > Second paragraph\n- Next",
      "• First paragraph\n\nSecond paragraph\n• Next",
    ],
    [
      "quote followed by its item's paragraph",
      "- > Quoted\n\n  Continue here\n- Next",
      "• Quoted\n\nContinue here\n\n• Next",
    ],
    [
      "loose bullet paragraphs",
      "- first paragraph\n\n  second paragraph\n- next",
      "• first paragraph\n\nsecond paragraph\n\n• next",
    ],
    [
      "loose ordered paragraphs",
      "1. first paragraph\n\n   second paragraph\n2. next",
      "1. first paragraph\n\nsecond paragraph\n\n2. next",
    ],
    [
      "loose blockquoted paragraphs",
      "> - first paragraph\n>\n>   second paragraph\n> - next",
      "• first paragraph\n\nsecond paragraph\n\n• next",
    ],
    ["tight heading items", "- # A\n- # B", "• A\n• B"],
    ["tight blockquote items", "- > quote\n- next", "• quote\n• next"],
    [
      "loose nested bullet lists",
      "- parent\n\n  - child\n\n- next",
      "• parent\n\n  • child\n• next",
    ],
    [
      "following paragraph",
      "- item 1\n- item 2\n\nParagraph after",
      "• item 1\n• item 2\n\nParagraph after",
    ],
  ])("separates %s", (_name, markdown, expected) => {
    expect(markdownToIR(markdown).text).toBe(expected);
  });
});
