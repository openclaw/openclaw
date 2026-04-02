import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools scoped working memory", () => {
  it("withholds durable-memory and recall tools when scoped working memory is enabled", () => {
    const names = createOpenClawCodingTools({
      sessionId: "session-1",
      runId: "run-1",
      workspaceDir: "/tmp/openclaw-workspace",
      workingMemoryPath: ".openclaw/working-memory/cron/nightly.md",
    }).map((tool) => tool.name);

    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("memory_get");
    expect(names.some((name) => name.startsWith("lcm_"))).toBe(false);
    expect(names).toContain("read");
    expect(names).toContain("write");
  });
});
