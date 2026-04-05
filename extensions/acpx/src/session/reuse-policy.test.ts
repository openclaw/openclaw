import { describe, expect, it } from "vitest";
import { shouldReuseExistingRecord } from "./reuse-policy.js";

describe("shouldReuseExistingRecord", () => {
  it("rejects reuse when the requested cwd changes", () => {
    expect(
      shouldReuseExistingRecord(
        {
          cwd: "/workspace/one",
          agentCommand: "codex --acp",
          acpSessionId: "sid-1",
        },
        {
          cwd: "/workspace/two",
          agentCommand: "codex --acp",
        },
      ),
    ).toBe(false);
  });

  it("rejects reuse when a persisted backend session id changed", () => {
    expect(
      shouldReuseExistingRecord(
        {
          cwd: "/workspace",
          agentCommand: "codex --acp",
          acpSessionId: "sid-1",
        },
        {
          cwd: "/workspace",
          agentCommand: "codex --acp",
          resumeSessionId: "sid-2",
        },
      ),
    ).toBe(false);
  });

  it("rejects reuse when the resolved agent command changes", () => {
    expect(
      shouldReuseExistingRecord(
        {
          cwd: "/workspace",
          agentCommand: "codex --acp",
          acpSessionId: "sid-1",
        },
        {
          cwd: "/workspace",
          agentCommand: "custom-codex --acp",
        },
      ),
    ).toBe(false);
  });

  it("keeps reuse enabled only for compatible records", () => {
    expect(
      shouldReuseExistingRecord(
        {
          cwd: "/workspace",
          agentCommand: "codex --acp",
          acpSessionId: "sid-1",
        },
        {
          cwd: "/workspace",
          agentCommand: "codex --acp",
          resumeSessionId: "sid-1",
        },
      ),
    ).toBe(true);
  });
});
