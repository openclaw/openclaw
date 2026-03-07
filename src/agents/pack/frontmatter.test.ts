import { describe, expect, it } from "vitest";
import {
  extractPackDescription,
  parsePackFrontmatter,
  resolvePackMetadata,
} from "./frontmatter.js";

describe("parsePackFrontmatter", () => {
  it("parses valid PACK.md frontmatter", () => {
    const content = `---
name: news-curator
description: AI news curator agent
author: garysng
version: 1.0.0
skills:
  - summarize
  - web-search
tags:
  - news
  - research
---

# News Curator`;

    const fm = parsePackFrontmatter(content);
    expect(fm.name).toBe("news-curator");
    expect(fm.description).toBe("AI news curator agent");
    expect(fm.author).toBe("garysng");
    expect(fm.version).toBe("1.0.0");
  });

  it("returns empty object for missing frontmatter", () => {
    const content = "# Just a heading\n\nSome text.";
    const fm = parsePackFrontmatter(content);
    expect(fm).toEqual({});
  });

  it("returns empty object for empty content", () => {
    const fm = parsePackFrontmatter("");
    expect(fm).toEqual({});
  });
});

describe("resolvePackMetadata", () => {
  it("extracts all metadata fields", () => {
    const fm: Record<string, string> = {
      name: "my-pack",
      description: "A test pack",
      author: "test-author",
      version: "2.0.0",
      skills: '["summarize","web-search"]',
      tags: '["news","ai"]',
    };

    const meta = resolvePackMetadata(fm);
    expect(meta.name).toBe("my-pack");
    expect(meta.description).toBe("A test pack");
    expect(meta.author).toBe("test-author");
    expect(meta.version).toBe("2.0.0");
    expect(meta.skills).toEqual(["summarize", "web-search"]);
    expect(meta.tags).toEqual(["news", "ai"]);
  });

  it("handles missing optional fields", () => {
    const meta = resolvePackMetadata({ name: "minimal" });
    expect(meta.name).toBe("minimal");
    expect(meta.description).toBeUndefined();
    expect(meta.author).toBeUndefined();
    expect(meta.version).toBeUndefined();
    expect(meta.skills).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });

  it("returns empty name for empty frontmatter", () => {
    const meta = resolvePackMetadata({});
    expect(meta.name).toBe("");
  });

  it("parses comma-separated skills", () => {
    const meta = resolvePackMetadata({ name: "test", skills: "a, b, c" });
    expect(meta.skills).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace from values", () => {
    const meta = resolvePackMetadata({
      name: "  spaced  ",
      description: "  desc  ",
      author: "  author  ",
    });
    expect(meta.name).toBe("spaced");
    expect(meta.description).toBe("desc");
    expect(meta.author).toBe("author");
  });
});

describe("extractPackDescription", () => {
  it("extracts body after frontmatter", () => {
    const content = `---
name: test
---

# My Pack

This is the description.`;

    const desc = extractPackDescription(content);
    expect(desc).toBe("# My Pack\n\nThis is the description.");
  });

  it("returns full content when no frontmatter", () => {
    const content = "# No frontmatter\n\nJust content.";
    const desc = extractPackDescription(content);
    expect(desc).toBe("# No frontmatter\n\nJust content.");
  });

  it("handles empty content", () => {
    expect(extractPackDescription("")).toBe("");
  });

  it("handles frontmatter-only content", () => {
    const content = `---
name: test
---`;
    const desc = extractPackDescription(content);
    expect(desc).toBe("");
  });
});
