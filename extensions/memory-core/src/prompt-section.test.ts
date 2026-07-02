// Memory Core prompt-section tests cover session-aware recall guidance.
import { describe, expect, it } from "vitest";
import { buildPromptSection } from "./prompt-section.js";

describe("buildPromptSection", () => {
  it("keeps mandatory recall guidance for private sessions", () => {
    const lines = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      sessionKey: "agent:main:discord:direct:user-1",
    });

    expect(lines.join("\n")).toContain("Before answering anything about prior work");
    expect(lines.join("\n")).toContain("run memory_search");
  });

  it("uses explicit-only recall guidance for shared sessions", () => {
    const lines = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      sessionKey: "agent:main:discord:channel:c1",
    });

    expect(lines.join("\n")).toContain("Shared sessions do not run long-term memory recall");
    expect(lines.join("\n")).toContain("explicitly asks");
    expect(lines.join("\n")).not.toContain("Before answering anything about prior work");
  });

  it("uses runtime chat type for opaque ACP-bound shared sessions", () => {
    const lines = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
      sessionKey: "agent:main:acp:binding:telegram:acct:abc123",
      chatType: "group",
    });

    expect(lines.join("\n")).toContain("Shared sessions do not run long-term memory recall");
    expect(lines.join("\n")).not.toContain("Before answering anything about prior work");
  });
});
