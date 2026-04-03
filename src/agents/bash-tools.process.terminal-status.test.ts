import { afterEach, describe, expect, it } from "vitest";
import { addSession, markExited, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

describe("process tool terminal status", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("preserves a stored failed terminal status even when exitCode is zero", async () => {
    const session = createProcessSessionFixture({
      id: "sess-failed-zero-exit",
      command: "codex exec",
      backgrounded: true,
    });
    session.aggregated = "final output";
    addSession(session);
    markExited(session, 0, null, "failed");

    const tool = createProcessTool();
    const result = await tool.execute("toolcall", {
      action: "poll",
      sessionId: "sess-failed-zero-exit",
    });

    expect(result.details).toMatchObject({
      status: "failed",
      exitCode: 0,
      aggregated: "final output",
    });
  });
});
