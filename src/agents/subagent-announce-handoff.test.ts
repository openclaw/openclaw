// A subagent-completion announce turn relays frozen child output into the
// parent topic. It must run tool-free so a child completion can never drive
// parent-topic bash/apply_patch. This guards the classifier that selects that
// tool-free handoff path.
import { describe, expect, it } from "vitest";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { isSubagentAnnounceCompletionHandoff } from "./subagent-announce-handoff.js";

const announceProvenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:openclaw:subagent:child",
  sourceChannel: "internal",
  sourceTool: "subagent_announce",
} as const;

const subagentCompletionEvent: AgentInternalEvent = {
  type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  source: "subagent",
  status: "ok",
  result: "child finished",
} as AgentInternalEvent;

describe("isSubagentAnnounceCompletionHandoff", () => {
  it("matches a subagent_announce inter-session completion handoff", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [subagentCompletionEvent],
      }),
    ).toBe(true);
  });

  it("does not match a normal human turn (no inter-session provenance)", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: undefined,
        internalEvents: [subagentCompletionEvent],
      }),
    ).toBe(false);
  });

  it("does not match an inter-session turn from a different source tool", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: { ...announceProvenance, sourceTool: "sessions_send" },
        internalEvents: [subagentCompletionEvent],
      }),
    ).toBe(false);
  });

  it("does not match an announce handoff without a subagent completion event", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [],
      }),
    ).toBe(false);
  });
});
