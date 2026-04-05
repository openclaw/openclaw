import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { __testing } from "./compact.js";

describe("buildCompactionDryRunDetails", () => {
  it("returns a boundary-only plan when no real conversation messages exist", () => {
    const details = __testing.buildCompactionDryRunDetails({
      messages: [] as AgentMessage[],
      contextWindowTokens: 8_000,
    });

    expect(details.dryRun).toBe(true);
    expect(details.stageTelemetry.entryStage).toBe("boundary");
    expect(details.stageTelemetry.plan).toEqual([
      { stage: "boundary", reason: "no_real_messages" },
    ]);
  });

  it("builds a conservative multi-stage plan for normal conversation history", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Need a compact summary of our work so far." },
      { role: "assistant", content: "Sure, here is the current state and next steps." },
    ];

    const details = __testing.buildCompactionDryRunDetails({
      messages,
      contextWindowTokens: 8_000,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
      recentTurnsPreserve: 3,
    });

    expect(details.stageTelemetry.entryStage).toBe("summarize_history");
    expect(details.stageTelemetry.plan.at(-1)).toEqual({
      stage: "finalize",
      reason: "summary_ready",
    });
    expect(details.stageTelemetry.qualityGuardEnabled).toBe(true);
    expect(details.qualityRetriesPlanned).toBe(2);
  });

  it("projects light trim when oversized tool results dominate the transcript", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Summarize the command output." },
      {
        role: "toolResult",
        toolCallId: "call_123",
        toolName: "exec",
        content: [{ type: "text", text: "A".repeat(8_000) }],
      } as AgentMessage,
      { role: "assistant", content: "Done." } as AgentMessage,
    ];

    const details = __testing.buildCompactionDryRunDetails({
      messages,
      contextWindowTokens: 8_000,
    });

    expect(details.lightTrim).toMatchObject({
      trimmedMessages: 1,
      trimmedToolResults: 1,
    });
    expect(details.stageTelemetry.entryStage).toBe("light_trim");
    expect(details.stageTelemetry.plan).toEqual(
      expect.arrayContaining([{ stage: "light_trim", reason: "oversized_tool_results_present" }]),
    );
  });
});
