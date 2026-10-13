import { describe, expect, it } from "vitest";
import type { AttemptParamsLike } from "./attempt-types.js";
import { buildCopilotPromptGuidance } from "./prompt-guidance.js";

const fullDelegationTools = [
  "message",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "skill_workshop",
  "subagents",
];

function buildGuidance(
  attempt: Partial<AttemptParamsLike> = {},
  callableToolNames: Iterable<string> = fullDelegationTools,
): string | undefined {
  return buildCopilotPromptGuidance({
    attempt: {
      agentId: "main",
      config: {},
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "automatic",
      ...attempt,
    } as AttemptParamsLike,
    callableToolNames,
  });
}

describe("buildCopilotPromptGuidance", () => {
  it("suppresses report-only delegation but keeps visible-reply guidance", () => {
    const guidance = buildGuidance({ delegationCapability: "report_only" });

    expect(guidance).not.toContain("## Delegation");
    expect(guidance).toContain("is your complete reply.");
  });

  it("omits the appended developer instructions for prompt mode none", () => {
    expect(buildGuidance({ promptMode: "none" })).toBeUndefined();
  });

  it("renders only the delegation operations present in the callable inventory", () => {
    const guidance = buildGuidance({}, [" sessions_spawn ", "sessions_spawn"]);

    expect(guidance).toContain("## Delegation");
    expect(guidance).toContain(
      "Announced completion is push-based; collectors require explicit result collection.",
    );
    expect(guidance).not.toContain("sessions_yield");
    expect(guidance).not.toContain("subagents(action=list)");
    expect(buildGuidance({}, ["sessions_yield", "subagents"])).not.toContain("## Delegation");
  });

  it("wraps conversation and subagent context without adding workspace prompt sections", () => {
    expect(buildGuidance({ extraSystemPrompt: "Conversation policy." })).toContain(
      "## Conversation Context\nConversation policy.",
    );
    const minimal = buildGuidance({ extraSystemPrompt: "Child policy.", promptMode: "minimal" });
    expect(minimal).toContain("## Subagent Context\nChild policy.");
    expect(minimal).not.toContain("## Workspace");
  });
});
