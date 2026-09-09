import { describe, expect, it } from "vitest";
import { createMSTeamsSmokeProofTrace } from "./smoke-proof-trace.js";

describe("createMSTeamsSmokeProofTrace", () => {
  it("emits route proof and ingress correlation without raw peer ids", () => {
    const trace = createMSTeamsSmokeProofTrace({
      accountId: "default",
      conversationId: "raw-teams-conversation",
      messageId: "raw-teams-message",
      route: {
        agentId: "r-harris",
        matchedBy: "binding.peer",
        sessionKey: "raw-session-key",
      },
      employeeIntakeSessionVisible: true,
    });

    expect(trace).toMatchObject({
      source: "msteams.inbound.dispatch",
      handlerDecisionTrace: "redacted",
      matchedBy: "binding.peer",
      routeAgentId: "r-harris",
      employeeIntakeSessionVisible: true,
      rawPeerExposed: false,
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("raw-teams-conversation");
    expect(serialized).not.toContain("raw-teams-message");
    expect(serialized).not.toContain("raw-session-key");
  });
});
