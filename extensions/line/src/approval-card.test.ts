// Line tests cover the Flex card for native approval prompts.
import type {
  ApprovalActionView,
  ExecApprovalPendingView,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildLinePendingApprovalCard } from "./approval-card.js";
import { resolveLineApprovalPostbackTap } from "./approval-postback.js";
import { LINE_FLEX_BUBBLE_MAX_BYTES } from "./flex-templates/message.js";

const gateway = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn<(params: object) => Promise<undefined>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolveApprovalOverGateway,
}));

const APPROVAL_ID = "6f4a1b2c-0d3e-4f5a-8b9c-0d1e2f3a4b5c";
const NOW_MS = 1_700_000_000_000;

function commandAnalysis(warningLines: string[]): ExecApprovalPendingView["commandAnalysis"] {
  return { commandCount: 1, nestedCommandCount: 0, riskKinds: ["destructive"], warningLines };
}

function decisionAction(
  decision: ApprovalActionView["decision"],
  label: string,
  style: ApprovalActionView["style"],
  approvalKind: PendingApprovalView["approvalKind"] = "exec",
): ApprovalActionView {
  return {
    decision,
    label,
    style,
    command: `/approve ${APPROVAL_ID} ${decision}`,
    action: { type: "approval", approvalId: APPROVAL_ID, approvalKind, decision },
  };
}

function execView(overrides: Partial<ExecApprovalPendingView> = {}): ExecApprovalPendingView {
  return {
    approvalId: APPROVAL_ID,
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [
      { label: "Agent", value: "main" },
      { label: "Host", value: "gateway" },
    ],
    commandText: "rm -rf ./build",
    actions: [
      decisionAction("allow-once", "Allow Once", "success"),
      decisionAction("allow-always", "Allow Always", "primary"),
      decisionAction("deny", "Deny", "danger"),
    ],
    expiresAtMs: NOW_MS + 120_000,
    ...overrides,
  };
}

function cardText(card: NonNullable<ReturnType<typeof buildLinePendingApprovalCard>>): string {
  return (card.bubble.body?.contents ?? [])
    .flatMap((content) =>
      content.type === "text" && typeof content.text === "string" ? [content.text] : [],
    )
    .join("\n\n");
}

function cardPostbackData(
  card: NonNullable<ReturnType<typeof buildLinePendingApprovalCard>>,
): string[] {
  return (card.bubble.footer?.contents ?? []).flatMap((content) =>
    content.type === "button" &&
    content.action.type === "postback" &&
    typeof content.action.data === "string"
      ? [content.action.data]
      : [],
  );
}

describe("LINE pending approval card", () => {
  it("carries one resolvable postback per offered decision", async () => {
    const card = buildLinePendingApprovalCard({
      view: execView(),
      nowMs: NOW_MS,
      channelSecret: "secret",
    });
    expect(card).not.toBeNull();
    expect(card?.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
    for (const data of cardPostbackData(card!)) {
      await resolveLineApprovalPostbackTap({
        // Cards on for exec, so the tapping approver decides.
        resolveConfig: () => ({
          channels: {
            line: {
              channelAccessToken: "token",
              channelSecret: "secret",
              allowFrom: ["U0123456789abcdef0123456789abcdef"],
            },
          },
          approvals: { exec: { enabled: true } },
        }),
        account: { accountId: "default", channelSecret: "secret" },
        data,
        senderId: "U0123456789abcdef0123456789abcdef",
      });
    }
    expect(gateway.resolveApprovalOverGateway.mock.calls.map(([params]) => params)).toEqual(
      (["allow-once", "allow-always", "deny"] as const).map((decision) =>
        expect.objectContaining({ approvalId: APPROVAL_ID, approvalKind: "exec", decision }),
      ),
    );
  });

  it("names the command in the card and in the notification text", () => {
    const card = buildLinePendingApprovalCard({
      view: execView(),
      nowMs: NOW_MS,
      channelSecret: "secret",
    });
    expect(card?.altText).toBe("Exec Approval Required: rm -rf ./build");
    expect(cardText(card!)).toContain("Command\nrm -rf ./build");
    expect(cardText(card!)).toContain(`Approval ID: ${APPROVAL_ID}`);
    expect(cardText(card!)).toContain("Expires in: 2m");
  });

  it("keeps the reason for the interruption on the card", () => {
    const card = buildLinePendingApprovalCard({
      view: execView({
        warningText: "Deletes files outside the workspace.",
        commandAnalysis: commandAnalysis(["removes a directory tree", "no confirmation prompt"]),
      }),
      nowMs: NOW_MS,
      channelSecret: "secret",
    });
    expect(cardText(card!)).toContain("Deletes files outside the workspace.");
    expect(cardText(card!)).toContain("Command analysis\n- removes a directory tree");
  });

  // Without a secret the tag is one anyone can compute and taps refuse it, so the card
  // is not drawn and the runtime sends the approval command text instead.
  it("declines the card when the account has no channel secret", () => {
    expect(
      buildLinePendingApprovalCard({ view: execView(), nowMs: NOW_MS, channelSecret: "" }),
    ).toBeNull();
  });

  it("declines the card when one offered decision is not drawable", () => {
    // A card missing a decision would steer the answer toward the ones it drew.
    const view = execView();
    const [first, ...rest] = view.actions;
    const { action: _dropped, ...withoutTypedAction } = first!;
    expect(
      buildLinePendingApprovalCard({
        view: { ...view, actions: [withoutTypedAction, ...rest] },
        nowMs: NOW_MS,
        channelSecret: "secret",
      }),
    ).toBeNull();
  });

  // The fields the view passes through raw: the auto-review rationale, its analysis
  // lines, and the metadata values. `commandText` arrives bounded by
  // `sanitizeExecApprovalDisplayText`, though a long multibyte command can still outgrow
  // the bubble and takes the same shortening path.
  it.each([
    ["rationale", (size: number) => execView({ warningText: "y".repeat(size) })],
    [
      "analysis line",
      (size: number) => execView({ commandAnalysis: commandAnalysis(["w".repeat(size)]) }),
    ],
    [
      "metadata value",
      (size: number) =>
        execView({ metadata: [{ label: "Env Overrides", value: "K".repeat(size) }] }),
    ],
  ])("shortens an oversized %s visibly instead of losing the prompt", (_label, build) => {
    const card = buildLinePendingApprovalCard({
      view: build(LINE_FLEX_BUBBLE_MAX_BYTES),
      nowMs: NOW_MS,
      channelSecret: "secret",
    });
    expect(card?.bodyShortened).toBe(true);
    expect(cardText(card!)).toContain("[shortened to fit LINE's card limit]");
    // The id stays reachable so the approver can still resolve it by command, once.
    expect(cardText(card!).split(`Approval ID: ${APPROVAL_ID}`)).toHaveLength(2);
    expect(cardPostbackData(card!)).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(card?.bubble), "utf8")).toBeLessThanOrEqual(
      LINE_FLEX_BUBBLE_MAX_BYTES,
    );
  });

  it("leaves a body that already fits unmarked", () => {
    const card = buildLinePendingApprovalCard({
      view: execView(),
      nowMs: NOW_MS,
      channelSecret: "secret",
    });
    expect(card?.bodyShortened).toBe(false);
    expect(cardText(card!)).not.toContain("[shortened");
  });

  it("names a system change by its summary", () => {
    const view: PendingApprovalView = {
      approvalId: APPROVAL_ID,
      approvalKind: "system-agent",
      phase: "pending",
      title: "OpenClaw change",
      metadata: [],
      commandText: "enable the LINE channel",
      operationSummary: "enable the LINE channel",
      actions: [
        decisionAction("allow-once", "Apply", "success", "system-agent"),
        decisionAction("deny", "Deny", "danger", "system-agent"),
      ],
      expiresAtMs: NOW_MS + 60_000,
    };
    const card = buildLinePendingApprovalCard({ view, nowMs: NOW_MS, channelSecret: "secret" });
    expect(card?.altText).toBe("OpenClaw Change Approval Required: enable the LINE channel");
    expect(cardText(card!)).toContain("Change\nenable the LINE channel");
  });

  it("names a plugin request by its title and description", () => {
    const view: PendingApprovalView = {
      approvalId: APPROVAL_ID,
      approvalKind: "plugin",
      phase: "pending",
      title: "Publish the release note",
      description: "workboard wants to post to the release channel",
      metadata: [{ label: "Plugin", value: "workboard" }],
      severity: "warning",
      actions: [
        decisionAction("allow-once", "Allow Once", "success", "plugin"),
        decisionAction("deny", "Deny", "danger", "plugin"),
      ],
      expiresAtMs: NOW_MS + 60_000,
    };
    const card = buildLinePendingApprovalCard({ view, nowMs: NOW_MS, channelSecret: "secret" });
    expect(card?.altText).toBe("Plugin Approval Required: Publish the release note");
    expect(cardText(card!)).toContain(
      "Request\nPublish the release note\nworkboard wants to post to the release channel",
    );
  });
});
