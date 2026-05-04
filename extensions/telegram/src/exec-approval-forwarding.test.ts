import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { describe, expect, it } from "vitest";
import { buildTelegramExecApprovalPendingPayload } from "./exec-approval-forwarding.js";

describe("telegram exec approval forwarding", () => {
  it("adds Telegram inline buttons for forwarded exec approval payloads", () => {
    const request: ExecApprovalRequest = {
      id: "req-1",
      createdAtMs: 1000,
      expiresAtMs: 6000,
      request: {
        command: "echo hello",
        agentId: "main",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny"],
      },
    };

    const payload = buildTelegramExecApprovalPendingPayload({ request, nowMs: 1000 });

    expect(payload.text).not.toContain("/approve");
    expect(payload.text).not.toContain("Run:");
    expect(payload.text).not.toContain("Other options:");
    expect(payload.interactive).toEqual(
      expect.objectContaining({
        blocks: expect.any(Array),
      }),
    );
    expect(payload.channelData).toEqual(
      expect.objectContaining({
        execApproval: expect.objectContaining({
          approvalId: "req-1",
          allowedDecisions: ["allow-once", "deny"],
        }),
        telegram: expect.objectContaining({
          buttons: [
            [{ text: "Allow Once", callback_data: "/approve req-1 allow-once", style: "success" }],
            [{ text: "Deny", callback_data: "/approve req-1 deny", style: "danger" }],
          ],
        }),
      }),
    );
  });

  it("uses Telegram-safe approval aliases for forwarded allow-always buttons", () => {
    const request: ExecApprovalRequest = {
      id: "req-2",
      createdAtMs: 1000,
      expiresAtMs: 6000,
      request: {
        command: "echo hello",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    };

    const payload = buildTelegramExecApprovalPendingPayload({ request, nowMs: 1000 });
    const telegram = payload.channelData?.telegram as
      | {
          buttons?: unknown;
        }
      | undefined;

    expect(payload.text).not.toContain("/approve");
    expect(telegram?.buttons).toEqual([
      [{ text: "Allow Once", callback_data: "/approve req-2 allow-once", style: "success" }],
      [{ text: "Allow Always", callback_data: "/approve req-2 always", style: "primary" }],
      [{ text: "Deny", callback_data: "/approve req-2 deny", style: "danger" }],
    ]);
  });

  it("includes Allow Always for forwarded exec approvals by default", () => {
    const request: ExecApprovalRequest = {
      id: "req-3",
      createdAtMs: 1000,
      expiresAtMs: 6000,
      request: {
        command: "echo hello",
      },
    };

    const payload = buildTelegramExecApprovalPendingPayload({ request, nowMs: 1000 });
    const telegram = payload.channelData?.telegram as
      | {
          buttons?: Array<Array<{ text: string }>>;
        }
      | undefined;

    expect(telegram?.buttons?.map((row) => row.map((button) => button.text))).toEqual([
      ["Allow Once"],
      ["Allow Always"],
      ["Deny"],
    ]);
  });
});
