import { describe, expect, it } from "vitest";
import { buildWikiPromptSection } from "./prompt-section.js";

describe("buildWikiPromptSection", () => {
  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const lines = buildWikiPromptSection({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    });

    expect(lines.join("\n")).toContain("`memory_search` with `corpus=all`");
    expect(lines.join("\n")).toContain("`memory_get` with `corpus=wiki` or `corpus=all`");
    expect(lines.join("\n")).toContain("wiki-specific ranking or provenance details");
  });

  it("stays empty when no wiki or memory-adjacent tools are registered", () => {
    expect(buildWikiPromptSection({ availableTools: new Set(["web_search"]) })).toEqual([]);
  });
});
