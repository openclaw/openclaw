import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ExecApprovalPendingView,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import {
  buildMSTeamsCanonicalApprovalTerminalCard,
  buildMSTeamsExpiredApprovalCard,
  buildMSTeamsPendingApprovalCard,
  buildMSTeamsResolvedApprovalCard,
} from "./approval-card.js";

function createExecPendingView() {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [
      { label: "Agent", value: "main" },
      { label: "Host", value: "gateway" },
    ],
    commandText: "npm run deploy",
    actions: [
      {
        decision: "allow-once",
        label: "Approve once",
        style: "success",
        command: "/approve approval-1 allow-once",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve approval-1 deny",
      },
    ],
    expiresAtMs: 61_000,
  } satisfies ExecApprovalPendingView;
}

describe("Microsoft Teams approval Adaptive Cards", () => {
  it.each([
    {
      view: {
        ...createExecPendingView(),
        approvalId: "system-agent:change-1",
        approvalKind: "system-agent",
        title: "OpenClaw change",
        operationSummary: "restart the Gateway",
      } satisfies PendingApprovalView,
      label: "OpenClaw Change",
      decision: "allow-once",
      decisionLabel: "Allowed once",
      subject: [
        { type: "TextBlock", text: "Change", weight: "Bolder", wrap: true },
        { type: "TextBlock", text: "restart the Gateway", wrap: true },
      ],
    },
  ] as const)(
    "preserves complete $label cards across phases",
    ({ view, label, decision, decisionLabel, subject }) => {
      const { actions, expiresAtMs, ...common } = view;
      const tokens = actions.map((_, index) => `approval-token-${index}`);
      const createToken = vi.spyOn(msTeamsApprovalControls, "createToken");
      for (const token of tokens) {
        createToken.mockReturnValueOnce(token);
      }
      const tail = [
        ...subject,
        {
          type: "FactSet",
          facts: [
            { title: "Approval ID:", value: view.approvalId },
            ...view.metadata.map(({ label: metadataLabel, value }) => ({
              title: `${metadataLabel}:`,
              value,
            })),
          ],
        },
      ];
      const heading = { type: "TextBlock", weight: "Bolder", size: "Medium", wrap: true };
      const subtitle = { type: "TextBlock", isSubtle: true, wrap: true };
      try {
        expect(buildMSTeamsPendingApprovalCard({ view, nowMs: 1_000 })).toEqual({
          approvalId: view.approvalId,
          approvalKind: view.approvalKind,
          expiresAtMs,
          card: {
            type: "AdaptiveCard",
            version: "1.5",
            body: [
              { ...heading, text: `${label} Approval Required` },
              { ...subtitle, text: "Expires in 60s" },
              ...tail,
            ],
            actions: actions.map(({ label: actionLabel }, index) => ({
              type: "Action.Submit",
              title: actionLabel,
              data: { openclawAction: "approval", token: tokens[index] },
            })),
          },
          actionTokens: actions.map(({ decision: actionDecision }, index) => ({
            token: tokens[index],
            decision: actionDecision,
          })),
          allowedDecisions: ["allow-once", "deny"],
        });
        expect(createToken).toHaveBeenCalledTimes(actions.length);
        for (const [resolvedBy, text] of [
          ["  reviewer  ", "Resolved by reviewer"],
          [" \t ", "Resolved"],
        ]) {
          expect(
            buildMSTeamsResolvedApprovalCard({
              ...common,
              phase: "resolved",
              decision,
              resolvedBy,
            }),
          ).toEqual({
            type: "AdaptiveCard",
            version: "1.5",
            body: [
              { ...heading, text: `${label} Approval: ${decisionLabel}` },
              { ...subtitle, text },
              ...tail,
            ],
          });
        }
        expect(buildMSTeamsExpiredApprovalCard({ ...common, phase: "expired" })).toEqual({
          type: "AdaptiveCard",
          version: "1.5",
          body: [
            { ...heading, text: `${label} Approval Expired` },
            { ...subtitle, text: "This approval request expired before it was resolved." },
            ...tail,
          ],
        });
      } finally {
        createToken.mockRestore();
      }
    },
  );

  it("displays the canonical winning decision when another surface resolved the approval first", () => {
    const result: ApprovalResolveResult = {
      applied: false,
      approval: {
        id: "approval-1",
        urlPath: "/approve/approval-1",
        createdAtMs: 1,
        expiresAtMs: 61_000,
        resolvedAtMs: 2,
        status: "denied",
        decision: "deny",
        reason: "user",
        presentation: {
          kind: "exec",
          commandText: "npm run deploy",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };

    const card = buildMSTeamsCanonicalApprovalTerminalCard(result);

    expect(card).toMatchObject({
      body: [
        { text: "Exec Approval: Denied" },
        { text: "Already resolved" },
        { text: "Command" },
        { text: "npm run deploy" },
        {
          facts: [
            { title: "Approval ID:", value: "approval-1" },
            { title: "Status:", value: "denied" },
            { title: "Decision:", value: "deny" },
            { title: "Reason:", value: "user" },
          ],
        },
      ],
    });
    expect(card).not.toHaveProperty("actions");

    const systemCard = buildMSTeamsCanonicalApprovalTerminalCard({
      ...result,
      approval: {
        ...result.approval,
        presentation: {
          kind: "system-agent",
          title: "OpenClaw change",
          description: "restart the Gateway",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    expect(systemCard.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "System Agent Approval: Denied" })]),
    );
  });
});
