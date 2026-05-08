import { describe, expect, it } from "vitest";
import { qqbotApprovalNativeRuntime } from "./handler-runtime.js";

type QQBotPayload = {
  text: string;
  keyboard: {
    content: {
      rows: Array<{
        buttons: Array<{
          render_data: { label: string };
          action: { data: string };
        }>;
      }>;
    };
  };
};

describe("qqbot approval runtime", () => {
  it("prints plugin command actions and keeps only decision buttons", async () => {
    const actions: Array<{
      kind: "command" | "decision";
      label: string;
      command: string;
      style: "primary" | "danger";
      decision?: "deny";
    }> = [
      {
        kind: "command",
        label: "Verify with World",
        command: "/agentkit approve plugin:approval-1 allow-once",
        style: "primary",
      },
      {
        kind: "decision",
        decision: "deny",
        label: "Deny",
        command: "/approve plugin:approval-1 deny",
        style: "danger",
      },
    ];

    const payload = (await qqbotApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: undefined,
      request: {
        id: "plugin:approval-1",
        request: {
          title: "World proof required",
          description: "Verify before running the tool.",
          actions,
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:approval-1",
        actions,
      } as never,
    })) as QQBotPayload;

    expect(payload.text).toContain("/agentkit approve plugin:approval-1 allow-once");
    expect(payload.text).toContain("World proof required");
    expect(
      payload.keyboard.content.rows[0]?.buttons.map((button) => button.render_data.label),
    ).toEqual(["\u274c \u62d2\u7edd"]);
    expect(JSON.stringify(payload.keyboard)).not.toContain("/agentkit approve");
  });
});
