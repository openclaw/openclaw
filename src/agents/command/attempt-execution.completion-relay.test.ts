import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import {
  SUBAGENT_COMPLETION_MESSAGE_ONLY_OUTCOME_INSTRUCTION,
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_COMPLETION_RELAY_ONLY_OUTCOME_INSTRUCTION,
} from "../subagents/completion/subagent-completion-instructions.js";
import { adaptCompletionRelayTurnForToolSurface } from "./attempt-execution.helpers.js";

describe("adaptCompletionRelayTurnForToolSurface", () => {
  it("rewrites prompt and task_completion events for tool-free completion relays", () => {
    const events: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: "subagent",
        announceType: "subagent task",
        childSessionKey: "agent:main:subagent:child-1",
        taskLabel: "check status",
        status: "ok",
        statusLabel: "completed successfully",
        result: "All checks passed.",
        replyInstruction: `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`,
      },
    ];
    const prompt = `Header\n\nAction:\nA completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`;

    const adapted = adaptCompletionRelayTurnForToolSurface({
      prompt,
      internalEvents: events,
      isSubagentAnnounceHandoff: true,
      completionRetainsRequesterTools: false,
      completionNeedsMessageDelivery: false,
    });

    expect(adapted.prompt).toContain(SUBAGENT_COMPLETION_RELAY_ONLY_OUTCOME_INSTRUCTION);
    expect(adapted.prompt).not.toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
    expect(adapted.internalEvents).toHaveLength(1);
    expect(adapted.internalEvents?.[0]?.replyInstruction).toContain(
      SUBAGENT_COMPLETION_RELAY_ONLY_OUTCOME_INSTRUCTION,
    );
    expect(events[0]?.replyInstruction).toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
  });

  it("preserves permitted message delivery guidance on message-only completion turns", () => {
    const events: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: "subagent",
        announceType: "subagent task",
        childSessionKey: "agent:main:subagent:child-msg",
        taskLabel: "deliver update",
        status: "ok",
        statusLabel: "completed successfully",
        result: "Done.",
        replyInstruction: `Process this result privately. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`,
      },
    ];
    const prompt = `Action:\nProcess this result privately. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`;

    const adapted = adaptCompletionRelayTurnForToolSurface({
      prompt,
      internalEvents: events,
      isSubagentAnnounceHandoff: true,
      completionRetainsRequesterTools: false,
      completionNeedsMessageDelivery: true,
    });

    expect(adapted.prompt).toContain(SUBAGENT_COMPLETION_MESSAGE_ONLY_OUTCOME_INSTRUCTION);
    expect(adapted.prompt).not.toContain("Do not attempt tool calls");
    expect(adapted.internalEvents?.[0]?.replyInstruction).toContain(
      SUBAGENT_COMPLETION_MESSAGE_ONLY_OUTCOME_INSTRUCTION,
    );
  });

  it("preserves continuation instructions when requester tools are retained or not a completion handoff", () => {
    const prompt = `Action:\n${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`;
    const events: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: "subagent",
        announceType: "subagent task",
        childSessionKey: "agent:main:subagent:child-2",
        taskLabel: "fix bug",
        status: "ok",
        statusLabel: "completed successfully",
        result: "Needs follow-up.",
        replyInstruction: SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
      },
    ];

    const retained = adaptCompletionRelayTurnForToolSurface({
      prompt,
      internalEvents: events,
      isSubagentAnnounceHandoff: true,
      completionRetainsRequesterTools: true,
    });
    expect(retained.prompt).toBe(prompt);
    expect(retained.internalEvents).toBe(events);

    const nonHandoff = adaptCompletionRelayTurnForToolSurface({
      prompt,
      internalEvents: events,
      isSubagentAnnounceHandoff: false,
      completionRetainsRequesterTools: false,
    });
    expect(nonHandoff.prompt).toBe(prompt);
    expect(nonHandoff.internalEvents).toBe(events);
  });
});
