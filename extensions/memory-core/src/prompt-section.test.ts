import { describe, expect, it } from "vitest";
import { buildPromptSection } from "./prompt-section.js";

describe("buildPromptSection", () => {
  it("includes thread-first recall guidance when memory_search and memory_get are available", () => {
    const sections = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "on",
    });

    expect(sections).toHaveLength(4);
    expect(sections[0]).toBe("## Memory Recall");
    expect(sections[1]).toContain(
      "first read the recent conversation context from the current thread/channel with sessions_history when available",
    );
    expect(sections[1]).toContain(
      "If the user uses a short deictic or anaphoric reference, regardless of language, interpret it from the immediately preceding thread/channel context first.",
    );
    expect(sections[1]).toContain(
      "If that nearby context does not confidently disambiguate the referent, use broader memory recall such as active context or memory files as supporting context",
    );
    expect(sections[2]).toBe(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  });

  it("returns no section when neither recall tool is available", () => {
    const sections = buildPromptSection({
      availableTools: new Set(),
      citationsMode: "off",
    });

    expect(sections).toEqual([]);
  });
});
