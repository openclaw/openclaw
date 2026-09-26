import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("nested list structure and spacing", () => {
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

  it("handles empty parent with nested items", () => {
    // This is a bit of an edge case - a list item that's just a marker followed by nested content
    const input = `-
  - Nested only
- Normal`;

    const result = markdownToIR(input);

    // Should still render the nested item with proper indentation
    expect(result.text).toContain("  • Nested only");
  });

  it.each([
    [
      "renders bullet items nested inside bullet items",
      "- Item 1\n  - Nested 1.1\n  - Nested 1.2\n- Item 2",
      "• Item 1\n  • Nested 1.1\n  • Nested 1.2\n• Item 2",
    ],
    [
      "renders ordered items nested inside bullet items",
      "- Bullet item\n  1. Ordered sub-item 1\n  2. Ordered sub-item 2\n- Another bullet",
      "• Bullet item\n  1. Ordered sub-item 1\n  2. Ordered sub-item 2\n• Another bullet",
    ],
    [
      "renders bullet items nested inside ordered items",
      "1. Ordered 1\n   - Bullet sub 1\n   - Bullet sub 2\n2. Ordered 2",
      "1. Ordered 1\n  • Bullet sub 1\n  • Bullet sub 2\n2. Ordered 2",
    ],
    [
      "renders ordered items nested inside ordered items",
      "1. First\n   1. Sub-first\n   2. Sub-second\n2. Second",
      "1. First\n  1. Sub-first\n  2. Sub-second\n2. Second",
    ],
    [
      "renders four levels of bullet nesting",
      "- L1\n  - L2\n    - L3\n      - L4\n- Back",
      "• L1\n  • L2\n    • L3\n      • L4\n• Back",
    ],
    [
      "renders three levels with multiple items at each level",
      "- A1\n  - B1\n    - C1\n    - C2\n  - B2\n- A2",
      "• A1\n  • B1\n    • C1\n    • C2\n  • B2\n• A2",
    ],
    [
      "renders bullet then ordered then bullet nesting",
      "- Bullet 1\n  1. Ordered 1.1\n     - Deep bullet\n  2. Ordered 1.2\n- Bullet 2",
      "• Bullet 1\n  1. Ordered 1.1\n    • Deep bullet\n  2. Ordered 1.2\n• Bullet 2",
    ],
    [
      "renders ordered then bullet then ordered nesting",
      "1. First\n   - Sub bullet\n     1. Deep ordered\n   - Another bullet\n2. Second",
      "1. First\n  • Sub bullet\n    1. Deep ordered\n  • Another bullet\n2. Second",
    ],
    ["handles sibling nested lists", "- A\n  - A1\n- B\n  - B1", "• A\n  • A1\n• B\n  • B1"],
    [
      "renders three levels of bullet nesting",
      "- Level 1\n  - Level 2\n    - Level 3\n- Back to 1",
      "• Level 1\n  • Level 2\n    • Level 3\n• Back to 1",
    ],
    ["keeps nested siblings single-spaced", "- A\n  - B\n  - C\n- D", "• A\n  • B\n  • C\n• D"],
    [
      "trims the top-level list ending",
      "- Item 1\n  - Nested\n- Item 2",
      "• Item 1\n  • Nested\n• Item 2",
    ],
    [
      "indents a nested list after the parent text",
      "- Parent text\n  - Child\n- Another parent",
      "• Parent text\n  • Child\n• Another parent",
    ],
    [
      "avoids triple newlines before loose nested bullet lists",
      "- parent\n\n  - child\n\n- next",
      "• parent\n\n  • child\n• next",
    ],
    [
      "avoids triple newlines before loose nested ordered lists",
      "1. parent\n\n   1. child\n\n2. next",
      "1. parent\n\n  1. child\n2. next",
    ],
    [
      "separates a bullet list from the following paragraph",
      "- item 1\n- item 2\n\nParagraph after",
      "• item 1\n• item 2\n\nParagraph after",
    ],
    [
      "separates an ordered list from the following paragraph",
      "1. item 1\n2. item 2\n\nParagraph after",
      "1. item 1\n2. item 2\n\nParagraph after",
    ],
  ])("%s", (_title, markdown, expected) => {
    const result = markdownToIR(markdown);
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("\n\n\n");
  });
});

describe("list paragraph spacing", () => {
  it.each([
    {
      title: "separates prose from a fenced block in a tight item",
      markdown: "- Run this:\n  ```sh\n  echo hello\n  ```\n- Done",
      expected: "• Run this:\necho hello\n• Done",
    },
    {
      title: "separates headings and paragraphs in a tight ordered item",
      markdown: "1. Intro\n   # Heading\n   Details\n2. Done",
      expected: "1. Intro\nHeading\n\nDetails\n2. Done",
    },
    {
      title: "preserves paragraph breaks inside a list-owned quote",
      markdown: "- > First paragraph\n  >\n  > Second paragraph\n- Next",
      expected: "• First paragraph\n\nSecond paragraph\n• Next",
    },
    {
      title: "separates a quote from its containing item's next paragraph",
      markdown: "- > Quoted\n\n  Continue here\n- Next",
      expected: "• Quoted\n\nContinue here\n\n• Next",
    },
    {
      title: "preserves paragraph breaks inside loose bullet list items",
      markdown: `- first paragraph

  second paragraph
- next`,
      expected: `• first paragraph

second paragraph

• next`,
    },
    {
      title: "preserves paragraph breaks inside loose ordered list items",
      markdown: `1. first paragraph

   second paragraph
2. next`,
      expected: `1. first paragraph

second paragraph

2. next`,
    },
    {
      title: "preserves paragraph breaks inside loose blockquoted list items",
      markdown: `> - first paragraph
>
>   second paragraph
> - next`,
      expected: `• first paragraph

second paragraph

• next`,
    },
    {
      title: "keeps tight heading list items single-spaced",
      markdown: `- # A
- # B`,
      expected: `• A
• B`,
    },
    {
      title: "keeps tight blockquote list items single-spaced",
      markdown: `- > quote
- next`,
      expected: `• quote
• next`,
    },
  ])("$title", ({ markdown, expected }) => {
    const result = markdownToIR(markdown);
    expect(result.text).toBe(expected);
  });
});
