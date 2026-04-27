import { describe, expect, it } from "vitest";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";

describe("buildSubagentInitialUserMessage", () => {
  it("does not embed a task string (avoids duplicating the system **Your Role** block)", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 1,
      maxSpawnDepth: 3,
      persistentSession: false,
    });
    const secret = "Xy9_UNIQUE_TASK_PLACEHOLDER_FOR_TEST";
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("[Subagent Task]:");
    expect(msg).toContain("**Your Role**");
    expect(msg).toContain("depth 1/3");
  });

  it("includes the persistent session note when requested", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 2,
      maxSpawnDepth: 4,
      persistentSession: true,
    });
    expect(msg).toContain("persistent and remains available");
  });
});
