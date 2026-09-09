// Msteams tests cover self-service employee onboarding decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_ACK,
  DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_FAILURE_ACK,
  createMSTeamsEmployeeOnboardingRequest,
  redactMSTeamsEmployeeOnboardingRequest,
  resolveMSTeamsEmployeeOnboardingAcknowledgement,
  resolveMSTeamsEmployeeOnboardingDecision,
  resolveMSTeamsEmployeeOnboardingFailureAcknowledgement,
} from "./employee-onboarding.js";

const cfgWithSelfService = {
  channels: {
    msteams: {
      employeeSelfServiceOnboarding: { enabled: true },
    },
  },
} as unknown as OpenClawConfig;

describe("msteams employee self-service onboarding", () => {
  it("passes through an existing exact Teams direct-peer assignment", () => {
    const decision = resolveMSTeamsEmployeeOnboardingDecision({
      cfg: cfgWithSelfService,
      isDirectMessage: true,
      route: {
        agentId: "kevin-k",
        accountId: "default",
        matchedBy: "binding.peer",
      },
      senderId: "29:kevin",
      senderName: "Kevin K",
      conversationId: "19:kevin@thread.v2",
    });

    expect(decision).toEqual({
      kind: "route-existing-assignment",
      agentId: "kevin-k",
    });
  });

  it("creates a recoverable pending request for an unassigned Teams direct peer", () => {
    const decision = resolveMSTeamsEmployeeOnboardingDecision({
      cfg: cfgWithSelfService,
      isDirectMessage: true,
      route: {
        agentId: "main",
        accountId: "default",
        matchedBy: "default",
      },
      senderId: "29:second-employee",
      senderName: "Second Employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T14:40:00.000Z"),
    });

    expect(decision.kind).toBe("pending-onboarding");
    if (decision.kind !== "pending-onboarding") {
      return;
    }
    expect(decision.request).toMatchObject({
      channel: "msteams",
      accountId: "default",
      peerKind: "direct",
      senderName: "Second Employee",
      status: "pending",
      requestedAt: "2026-08-20T14:40:00.000Z",
      reason: "missing-direct-peer-assignment",
      protectedRoute: {
        peerId: "29:second-employee",
        conversationId: "19:second@thread.v2",
      },
    });
    expect(decision.request.id).toMatch(/^msteams-employee-onboarding-[a-f0-9]{24}$/u);
    expect(decision.request.peerHash).toMatch(/^[a-f0-9]{24}$/u);
    expect(decision.request.conversationHash).toMatch(/^[a-f0-9]{24}$/u);
    expect(JSON.stringify(redactMSTeamsEmployeeOnboardingRequest(decision.request))).not.toContain(
      "29:second-employee",
    );
    expect(JSON.stringify(redactMSTeamsEmployeeOnboardingRequest(decision.request))).not.toContain(
      "19:second@thread.v2",
    );
  });

  it("does not alter routing when self-service onboarding is disabled", () => {
    const decision = resolveMSTeamsEmployeeOnboardingDecision({
      cfg: {},
      isDirectMessage: true,
      route: {
        agentId: "main",
        accountId: "default",
        matchedBy: "default",
      },
      senderId: "29:unknown",
      conversationId: "19:unknown@thread.v2",
    });

    expect(decision).toEqual({ kind: "pass-through", reason: "disabled" });
  });

  it("uses a default acknowledgement unless config overrides it", () => {
    expect(resolveMSTeamsEmployeeOnboardingAcknowledgement(cfgWithSelfService)).toBe(
      DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_ACK,
    );
    expect(
      resolveMSTeamsEmployeeOnboardingAcknowledgement({
        channels: {
          msteams: {
            employeeSelfServiceOnboarding: {
              enabled: true,
              acknowledgementText:
                "Your employee agent setup has started. Please be patient as your onboarding begins. This process may take several minutes on first setup.",
            },
          },
        },
      } as unknown as OpenClawConfig),
    ).toBe(
      "Your employee agent setup has started. Please be patient as your onboarding begins. This process may take several minutes on first setup.",
    );
    expect(resolveMSTeamsEmployeeOnboardingFailureAcknowledgement(cfgWithSelfService)).toBe(
      DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_FAILURE_ACK,
    );
    expect(
      resolveMSTeamsEmployeeOnboardingFailureAcknowledgement({
        channels: {
          msteams: {
            employeeSelfServiceOnboarding: {
              enabled: true,
              failureAcknowledgementText: "Your setup request could not be recorded.",
            },
          },
        },
      } as unknown as OpenClawConfig),
    ).toBe("Your setup request could not be recorded.");
  });

  it("builds stable request ids for repeat messages from the same Teams peer", () => {
    const first = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T14:40:00.000Z"),
    });
    const second = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:new-conversation@thread.v2",
      now: new Date("2026-08-20T14:41:00.000Z"),
    });

    expect(second.id).toBe(first.id);
    expect(second.peerHash).toBe(first.peerHash);
    expect(second.conversationHash).not.toBe(first.conversationHash);
  });
});
