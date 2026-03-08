import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import { listCoreToolSections, resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("openclaw relationship tools", () => {
  it("does not register relationship query tools for ordinary sessions", () => {
    const names = createOpenClawTools().map((tool) => tool.name);
    expect(names).not.toContain("relationship_lookup");
    expect(names).not.toContain("relationship_neighbors");
    expect(names).not.toContain("relationship_explain");
  });

  it("registers relationship query tools for SRE sessions when enabled", () => {
    const names = createOpenClawTools({
      config: {
        sre: {
          relationshipIndex: {
            enabled: true,
          },
        },
      },
      agentSessionKey: "agent:sre-verifier:main",
    }).map((tool) => tool.name);

    expect(names).toContain("relationship_lookup");
    expect(names).toContain("relationship_neighbors");
    expect(names).toContain("relationship_explain");
  });

  it("keeps relationship tools out of default core catalog profiles", () => {
    const codingPolicy = resolveCoreToolProfilePolicy("coding");
    const memorySection = listCoreToolSections().find((section) => section.id === "memory");

    expect(codingPolicy?.allow).not.toContain("relationship_lookup");
    expect(codingPolicy?.allow).not.toContain("relationship_neighbors");
    expect(codingPolicy?.allow).not.toContain("relationship_explain");
    expect(memorySection?.tools.map((tool) => tool.id)).not.toContain("relationship_lookup");
  });
});
