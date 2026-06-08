import { beforeEach, describe, expect, it, vi } from "vitest";
import * as announceOutput from "./subagent-announce-output.js";
import {
  LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
  resolveStaleActiveSubagentOutcome,
} from "./subagent-lost-context-completion.js";

describe("resolveStaleActiveSubagentOutcome", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when child session has readable assistant output", async () => {
    vi.spyOn(announceOutput, "readSubagentOutput").mockResolvedValue(
      "# ARCHITECTURE.md\nrelease readiness design",
    );
    await expect(
      resolveStaleActiveSubagentOutcome({
        childSessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toEqual({ status: "ok" });
  });

  it("returns lost-context error when no readable output is available", async () => {
    vi.spyOn(announceOutput, "readSubagentOutput").mockResolvedValue(undefined);
    await expect(
      resolveStaleActiveSubagentOutcome({
        childSessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });

  it("returns lost-context error when output is whitespace only", async () => {
    vi.spyOn(announceOutput, "readSubagentOutput").mockResolvedValue("   \n  ");
    await expect(
      resolveStaleActiveSubagentOutcome({
        childSessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });
});
