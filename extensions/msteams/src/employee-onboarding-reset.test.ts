// Msteams tests cover reset planning for repeatable employee onboarding tests.
import { describe, expect, it } from "vitest";
import {
  createMSTeamsEmployeeOnboardingResetPlan,
  redactMSTeamsEmployeeOnboardingResetPlan,
} from "./employee-onboarding-reset.js";
import { createMSTeamsEmployeeOnboardingRequest } from "./employee-onboarding.js";

describe("msteams employee onboarding reset plan", () => {
  it("plans a side-effect-free Kevin reset from the protected Teams peer", () => {
    const plan = createMSTeamsEmployeeOnboardingResetPlan({
      accountId: "default",
      senderId: "29:kevin-teams-peer",
      conversationId: "19:kevin@thread.v2",
      employee: {
        displayName: "Kevin K",
        email: "kkilgo@ftsc.com",
        desiredSlug: "kkilgo",
      },
    });
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:kevin-teams-peer",
      conversationId: "19:kevin@thread.v2",
    });

    expect(plan).toMatchObject({
      dryRun: true,
      status: "ready",
      target: {
        accountId: "default",
        peerKind: "direct",
        peerHash: request.peerHash,
        conversationHash: request.conversationHash,
        requestId: request.id,
        employee: {
          displayName: "Kevin K",
          email: "kkilgo@ftsc.com",
          slug: "kkilgo",
        },
        protectedRoute: {
          peerId: "29:kevin-teams-peer",
          conversationId: "19:kevin@thread.v2",
        },
      },
      cleanup: {
        pendingRequest: {
          namespace: "employee-onboarding-requests",
          key: request.id,
        },
        routeBinding: {
          agentId: "kkilgo",
        },
        stack: {
          name: "employee-agent-kkilgo",
          command: "docker stack rm 'employee-agent-kkilgo'",
        },
        service: {
          name: "employee-agent-kkilgo",
        },
        secret: {
          name: "employee_agent_kkilgo_token_v1",
          command: "docker secret rm 'employee_agent_kkilgo_token_v1'",
        },
        auth: {
          agentId: "kkilgo",
          provider: "openai",
          profileGlob: "kkilgo:openai:*",
          orderKey: "kkilgo:openai",
        },
      },
      approvalRequired: true,
      sideEffects: [],
    });
    expect(plan.cleanup.routeBinding?.command).toContain("--peer-id '29:kevin-teams-peer'");
    expect(plan.cleanup.paths.map((entry) => entry.path)).toEqual([
      "/srv/openclaw/data/employee-agents/kkilgo",
      "/srv/openclaw/data/employee-agents/kkilgo/agent",
      "/srv/openclaw/data/employee-agents/kkilgo/config",
      "/srv/openclaw/data/employee-agents/kkilgo/state/.openclaw",
      "/srv/openclaw/data/employee-agents/kkilgo/workspace",
      "/srv/openclaw/data/employee-agents/kkilgo/shared",
      "/srv/openclaw/stacks/employee-agent-kkilgo",
    ]);
    expect(plan.validation).toContain(
      "a new first Teams message recreates exactly one pending onboarding request",
    );
  });

  it("redacts protected Teams route data and raw route cleanup commands", () => {
    const plan = createMSTeamsEmployeeOnboardingResetPlan({
      accountId: "default",
      senderId: "29:kevin-teams-peer",
      conversationId: "19:kevin@thread.v2",
      employee: {
        displayName: "Kevin K",
        email: "kkilgo@ftsc.com",
        desiredSlug: "kkilgo",
      },
    });

    const redacted = redactMSTeamsEmployeeOnboardingResetPlan(plan);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("29:kevin-teams-peer");
    expect(serialized).not.toContain("19:kevin@thread.v2");
    expect(redacted.target.protectedRoute).toMatchObject({
      peerId: "[protected]",
      peerHash: plan.target.peerHash,
      conversationId: "[protected]",
      conversationHash: plan.target.conversationHash,
    });
    expect(redacted.cleanup.routeBinding?.command).toBe(
      "openclaw agents unbind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json",
    );
  });

  it("blocks reset planning without an exact Teams peer", () => {
    expect(
      createMSTeamsEmployeeOnboardingResetPlan({
        accountId: "default",
        employee: {
          displayName: "Kevin K",
          email: "kkilgo@ftsc.com",
          desiredSlug: "kkilgo",
        },
      }),
    ).toMatchObject({
      dryRun: true,
      status: "blocked",
      reason: "missing-teams-peer",
      sideEffects: [],
    });
  });
});
