import { describe, expect, it } from "vitest";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";

type SlackActionsBlock = { type?: string; elements?: unknown[] };
type SlackPendingPayload = { text: string; blocks: SlackActionsBlock[] };
type SlackResolvedPayload = { text: string; blocks: Array<{ type?: string }> };

function findSlackActionsBlock(blocks: SlackActionsBlock[]) {
  return blocks.find((block) => block.type === "actions");
}

describe("slackApprovalNativeRuntime", () => {
  it("renders only the allowed pending actions", async () => {
    const payload = (await slackApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        app: {} as never,
        config: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        metadata: [],
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
      } as never,
    })) as SlackPendingPayload;

    expect(payload.text).toContain("*Exec approval required*");
    const actionsBlock = findSlackActionsBlock(payload.blocks);
    const labels = (actionsBlock?.elements ?? []).map((element) =>
      typeof element === "object" &&
      element &&
      typeof (element as { text?: { text?: unknown } }).text?.text === "string"
        ? (element as { text: { text: string } }).text.text
        : "",
    );

    expect(labels).toEqual(["Allow Once", "Deny"]);
    expect(JSON.stringify(payload.blocks)).not.toContain("Allow Always");
  });

  it("renders resolved updates without interactive blocks", async () => {
    const result = await slackApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: {
        app: {} as never,
        config: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      resolved: {
        id: "req-1",
        decision: "allow-once",
        resolvedBy: "U123APPROVER",
        ts: 0,
      } as never,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        decision: "allow-once",
        commandText: "echo hi",
        resolvedBy: "U123APPROVER",
      } as never,
      entry: {
        channelId: "D123APPROVER",
        messageTs: "1712345678.999999",
      },
    });
    expect(result.kind).toBe("update");
    if (result.kind !== "update") {
      throw new Error("expected Slack resolved update payload");
    }
    const resolvedPayload = result.payload as SlackResolvedPayload;
    expect(resolvedPayload.text).toContain("*Exec approval: Allowed once*");
    expect(resolvedPayload.text).toContain("Resolved by <@U123APPROVER>.");
    expect(resolvedPayload.blocks.some((block) => block.type === "actions")).toBe(false);
  });
});
