import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  it("keeps promised asynchronous work open in the agent bundle prompt", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp/openclaw" });

    expect(prompt).toContain("## Promised Work");
    expect(prompt).toContain("creates follow-through ownership");
    expect(prompt).toContain("push-based completion/watch path");
    expect(prompt).toContain("result/link/proof or a concrete blocker");
    expect(prompt).toContain("Progress like `running` is not completion");
    expect(prompt.match(/## Promised Work/g)).toHaveLength(1);
  });
});
