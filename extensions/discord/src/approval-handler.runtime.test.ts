// Discord tests cover approval handler plugin behavior.
import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("discordApprovalNativeRuntime", () => {
  it("renders external verification commands for plugin pending approvals", async () => {
    const payload = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      request: {
        id: "plugin:req-1",
        request: {
          title: "World proof required",
          description: "Verify with World before exec runs.",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:req-1",
        phase: "pending",
        title: "World proof required",
        description: "Verify with World before exec runs.",
        metadata: [],
        severity: "warning",
        pluginId: "agentkit",
        toolName: "exec",
        externalResolution: {
          label: "Verify with World",
          commands: [
            {
              decision: "allow-once",
              label: "Verify once",
              description: "Approve this blocked action only",
              command: "/agentkit approve plugin:req-1 allow-once",
            },
          ],
        },
        actions: [
          {
            decision: "deny",
            label: "Deny",
            style: "danger",
            command: "/approve plugin:req-1 deny",
          },
        ],
        expiresAtMs: 1_000,
      },
    });

    const serialized = JSON.stringify(payload.body);
    expect(serialized).toContain("External Verification");
    expect(serialized).toContain("Verify with World");
    expect(serialized).toContain("/agentkit approve plugin:req-1 allow-once");
    expect(serialized).toContain("Deny");
    expect(serialized).not.toContain("Allow Once");
  });

  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: {
        id: "req-1",
        request: {
          command: "hostname",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
