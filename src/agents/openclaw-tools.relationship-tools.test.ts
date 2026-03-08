import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw relationship tools", () => {
  it("registers relationship query tools", () => {
    const names = createOpenClawTools().map((tool) => tool.name);
    expect(names).toContain("relationship_lookup");
    expect(names).toContain("relationship_neighbors");
    expect(names).toContain("relationship_explain");
  });
});
