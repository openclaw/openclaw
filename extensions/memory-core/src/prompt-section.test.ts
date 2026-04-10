import { describe, expect, it } from "vitest";
import { buildPromptSection } from "./prompt-section.js";

describe("buildPromptSection", () => {
  it("returns Dali local-v1 guidance when only the Dali tool is available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["dali_local_v1_retrieve_context"]),
    });
    expect(result[0]).toBe("## Dali Local-v1 Retrieval");
    expect(result[1]).toContain("dali_local_v1_retrieve_context");
    expect(result[1]).toContain("Dali/local-v1-specific context");
    expect(result[1]).toContain("not describe it as generic global memory");
    expect(result.at(-1)).toBe("");
  });

  it("adds Dali local-v1 guidance alongside normal memory recall guidance", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get", "dali_local_v1_retrieve_context"]),
    });
    expect(result).toContain("## Memory Recall");
    expect(result).toContain("## Dali Local-v1 Retrieval");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  });
});
