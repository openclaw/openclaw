import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import {
  buildMSTeamsCanonicalApprovalTerminalCard,
  buildMSTeamsExpiredApprovalCard,
  buildMSTeamsPendingApprovalCard,
  buildMSTeamsResolvedApprovalCard,
} from "./approval-card.js";

const view = {
  approvalId: "system-agent:change-1",
  approvalKind: "system-agent",
  phase: "pending",
  title: "OpenClaw change",
  commandText: "npm run deploy",
  operationSummary: "restart the Gateway",
  metadata: [
    { label: "Agent", value: "main" },
    { label: "Host", value: "gateway" },
  ],
  actions: [
    { decision: "allow-once", label: "Approve once", style: "success", command: "" },
    { decision: "deny", label: "Deny", style: "danger", command: "" },
  ],
  expiresAtMs: 61_000,
} satisfies PendingApprovalView;

afterEach(() => vi.restoreAllMocks());

it("preserves complete OpenClaw Change cards across phases", () => {
  const { actions, expiresAtMs, ...common } = view;
  const tokens = actions.map((_, index) => `approval-token-${index}`);
  const createToken = vi.spyOn(msTeamsApprovalControls, "createToken");
  for (const token of tokens) {
    createToken.mockReturnValueOnce(token);
  }
  const tail = [
    { type: "TextBlock", text: "Change", weight: "Bolder", wrap: true },
    { type: "TextBlock", text: "restart the Gateway", wrap: true },
    {
      type: "FactSet",
      facts: [
        { title: "Approval ID:", value: view.approvalId },
        ...view.metadata.map(({ label, value }) => ({ title: `${label}:`, value })),
      ],
    },
  ];
  const heading = { type: "TextBlock", weight: "Bolder", size: "Medium", wrap: true };
  const subtitle = { type: "TextBlock", isSubtle: true, wrap: true };
  const card = (title: string, text: string) => ({
    type: "AdaptiveCard",
    version: "1.5",
    body: [{ ...heading, text: title }, { ...subtitle, text }, ...tail],
  });
  expect(buildMSTeamsPendingApprovalCard({ view, nowMs: 1_000 })).toEqual({
    approvalId: view.approvalId,
    approvalKind: view.approvalKind,
    expiresAtMs,
    card: {
      ...card("OpenClaw Change Approval Required", "Expires in 60s"),
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
  ] as const) {
    expect(
      buildMSTeamsResolvedApprovalCard({
        ...common,
        phase: "resolved",
        decision: "allow-once",
        resolvedBy,
      }),
    ).toEqual(card("OpenClaw Change Approval: Allowed once", text));
  }
  expect(buildMSTeamsExpiredApprovalCard({ ...common, phase: "expired" })).toEqual(
    card(
      "OpenClaw Change Approval Expired",
      "This approval request expired before it was resolved.",
    ),
  );
});

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
