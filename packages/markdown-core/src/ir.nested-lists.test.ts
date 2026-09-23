import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("Nested Lists - 2 Level Nesting", () => {
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
      "renders bullet items nested inside bullet items with proper indentation",
      `- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
      `• Item 1
  • Nested 1.1
  • Nested 1.2
• Item 2`,
    ],
    [
      "renders ordered items nested inside bullet items",
      `- Bullet item
  1. Ordered sub-item 1
  2. Ordered sub-item 2
- Another bullet`,
      `• Bullet item
  1. Ordered sub-item 1
  2. Ordered sub-item 2
• Another bullet`,
    ],
    [
      "renders bullet items nested inside ordered items",
      `1. Ordered 1
   - Bullet sub 1
   - Bullet sub 2
2. Ordered 2`,
      `1. Ordered 1
  • Bullet sub 1
  • Bullet sub 2
2. Ordered 2`,
    ],
    [
      "renders ordered items nested inside ordered items",
      `1. First
   1. Sub-first
   2. Sub-second
2. Second`,
      `1. First
  1. Sub-first
  2. Sub-second
2. Second`,
    ],
    [
      "renders 4 levels of bullet nesting",
      `- L1
  - L2
    - L3
      - L4
- Back`,
      `• L1
  • L2
    • L3
      • L4
• Back`,
    ],
    [
      "renders 3 levels with multiple items at each level",
      `- A1
  - B1
    - C1
    - C2
  - B2
- A2`,
      `• A1
  • B1
    • C1
    • C2
  • B2
• A2`,
    ],
    [
      "renders complex mixed nesting (bullet > ordered > bullet)",
      `- Bullet 1
  1. Ordered 1.1
     - Deep bullet
  2. Ordered 1.2
- Bullet 2`,
      `• Bullet 1
  1. Ordered 1.1
    • Deep bullet
  2. Ordered 1.2
• Bullet 2`,
    ],
    [
      "renders ordered > bullet > ordered nesting",
      `1. First
   - Sub bullet
     1. Deep ordered
   - Another bullet
2. Second`,
      `1. First
  • Sub bullet
    1. Deep ordered
  • Another bullet
2. Second`,
    ],
    [
      "handles sibling nested lists at same level",
      `- A
  - A1
- B
  - B1`,
      `• A
  • A1
• B
  • B1`,
    ],
  ])("%s", (_title, markdown, expected) => {
    const input = markdown;

    const result = markdownToIR(input);

    expect(result.text).toBe(expected);
  });
});

describe("Nested Lists - 3+ Level Deep Nesting", () => {
  it("renders 3 levels of bullet nesting", () => {
    const input = `- Level 1
  - Level 2
    - Level 3
- Back to 1`;

    const result = markdownToIR(input);

    const expected = `• Level 1
  • Level 2
    • Level 3
• Back to 1`;

    expect(result.text).toBe(expected);
  });
});

describe("Nested Lists - Newline Handling", () => {
  it("does not produce double newlines between nested items", () => {
    const input = `- A
  - B
  - C
- D`;

    const result = markdownToIR(input);

    // Between B and C there should be exactly one newline
    expect(result.text).toContain("  • B\n  • C");
    expect(result.text).not.toContain("  • B\n\n  • C");
  });

  it("properly terminates top-level list (trimmed output)", () => {
    const input = `- Item 1
  - Nested
- Item 2`;

    const result = markdownToIR(input);

    expect(result.text).toBe("• Item 1\n  • Nested\n• Item 2");
  });
});

describe("Nested Lists - Edge Cases", () => {
  it("handles empty parent with nested items", () => {
    // This is a bit of an edge case - a list item that's just a marker followed by nested content
    const input = `-
  - Nested only
- Normal`;

    const result = markdownToIR(input);

    // Should still render the nested item with proper indentation
    expect(result.text).toContain("  • Nested only");
  });

  it("handles nested list as first child of parent item", () => {
    const input = `- Parent text
  - Child
- Another parent`;

    const result = markdownToIR(input);

    // The child should appear indented under the parent
    expect(result.text).toContain("• Parent text\n  • Child");
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
    const input = markdown;

    const result = markdownToIR(input);

    expect(result.text).toBe(expected);
  });

  it("does not add triple newlines before loose nested bullet lists", () => {
    const input = `- parent

  - child

- next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• parent

  • child
• next`);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("does not add triple newlines before loose nested ordered lists", () => {
    const input = `1. parent

   1. child

2. next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`1. parent

  1. child
2. next`);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("adds blank line between bullet list and following paragraph", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    expect(result.text).toBe("• item 1\n• item 2\n\nParagraph after");
  });

  it("adds blank line between ordered list and following paragraph", () => {
    const input = `1. item 1
2. item 2

Paragraph after`;
    const result = markdownToIR(input);
    expect(result.text).toContain("item 2\n\nParagraph");
  });
});
