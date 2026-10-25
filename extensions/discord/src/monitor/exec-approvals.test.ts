import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecApprovalCustomId, parseExecApprovalData } from "../approval-custom-id.js";
import { parseCustomId } from "../internal/components.base.js";
import type { BaseComponentInteraction, ComponentData } from "../internal/discord.js";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>();
  return {
    ...actual,
    resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
  };
});

import {
  createDiscordExecApprovalButtonContext,
  createExecApprovalButton,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["execApprovals"],
): OpenClawConfig {
  return { channels: { discord: { token: "discord-token", execApprovals } } } as OpenClawConfig;
}

const approved = async () => ({ ok: true as const, resolution: createApprovalResolution() });
function createButton(resolveApproval = approved) {
  return createExecApprovalButton({ getApprovers: () => ["123"], resolveApproval });
}
function createContext() {
  const config = { enabled: true, approvers: ["123"] };
  return createDiscordExecApprovalButtonContext({
    cfg: buildConfig(config),
    accountId: "default",
    config,
  });
}
const click = { kind: "exec", id: "abc", action: "allow-once" };

function createInteraction(
  overrides?: Partial<BaseComponentInteraction>,
  approvalKind: Parameters<typeof buildExecApprovalCustomId>[1] = "exec",
  approvalId = "abc",
): BaseComponentInteraction {
  return {
    userId: "123",
    reply: vi.fn(),
    acknowledge: vi.fn(),
    message: { id: "message-1" },
    fetchReply: vi.fn(async () => ({
      components: [
        {
          type: 1,
          components: (["allow-once", "allow-always", "deny"] as const).map((decision) => ({
            type: 2,
            custom_id: buildExecApprovalCustomId(approvalId, approvalKind, decision),
          })),
        },
      ],
    })),
    editReply: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  } as unknown as BaseComponentInteraction;
}

function createApprovalResolution(params?: {
  id?: string;
  applied?: boolean;
  status?: "allowed" | "denied" | "expired" | "cancelled";
  decision?: "allow-once" | "allow-always" | "deny";
}): ApprovalResolveResult {
  const status = params?.status ?? "allowed";
  return {
    applied: params?.applied ?? true,
    approval: {
      id: params?.id ?? "abc",
      status,
      ...(status === "allowed" ? { decision: params?.decision ?? "allow-once" } : {}),
      ...(status === "denied" ? { decision: "deny" } : {}),
    },
  } as ApprovalResolveResult;
}

describe("discord exec approval monitor helpers", () => {
  beforeEach(() => {
    resolveApprovalOverGatewayMock.mockReset();
  });

  it.each([
    ["exec", "plugin:looks-like-plugin", "allow-once"],
    ["plugin", "plain-plugin-id", "deny"],
    ["system-agent", "change-1", "allow-once"],
    ["system-agent", "change-2", "deny"],
  ] as const)("round-trips %s approval custom ids", (approvalKind, approvalId, action) => {
    const customId = buildExecApprovalCustomId(approvalId, approvalKind, action);
    const parsed = parseCustomId(customId);

    expect(parsed.key).toBe("execapproval");
    expect(parseExecApprovalData(parsed.data)).toEqual({
      approvalId,
      approvalKind,
      action,
    });
  });

  it("rejects malformed or ownerless button payloads", () => {
    expect(parseExecApprovalData({ kind: "exec", id: "abc", action: "invalid" })).toBeNull();
    expect(parseExecApprovalData({ kind: "tool", id: "abc", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ id: "abc", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ kind: "exec", id: "%zz", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ kind: "plugin", action: "deny" } as ComponentData)).toBeNull();
  });

  it("rejects invalid approval button payloads", async () => {
    const interaction = createInteraction();
    const button = createButton();

    await button.run(interaction, { id: "", action: "" });

    expect(interaction["reply"]).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      ephemeral: true,
    });
  });

  it.each(["exec", "plugin", "system-agent"] as const)(
    "blocks non-approvers from approving %s clicks before resolution",
    async (approvalKind) => {
      const interaction = createInteraction({ userId: "999" });
      const resolveApproval = vi.fn(approved);
      const button = createButton(resolveApproval);

      await button.run(interaction, { kind: approvalKind, id: "abc", action: "allow-once" });

      expect(interaction["reply"]).toHaveBeenCalledWith({
        content: "⛔ You are not authorized to approve requests.",
        ephemeral: true,
      });
      expect(resolveApproval).not.toHaveBeenCalled();
    },
  );

  it.each(["exec", "plugin", "system-agent"] as const)(
    "acknowledges and resolves valid %s approval clicks",
    async (approvalKind) => {
      const editReply = vi.fn();
      const interaction = createInteraction({ editReply }, approvalKind);
      resolveApprovalOverGatewayMock.mockResolvedValue(createApprovalResolution());
      const ctx = createContext();
      expect(ctx.getApprovers()).toEqual(["123"]);
      const button = createExecApprovalButton(ctx);

      await button.run(interaction, { kind: approvalKind, id: "abc", action: "allow-once" });

      expect(interaction["acknowledge"]).toHaveBeenCalled();
      expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
        cfg: buildConfig({ enabled: true, approvers: ["123"] }),
        approvalId: "abc",
        approvalKind,
        decision: "allow-once",
        channel: "discord",
        accountId: "default",
        senderId: "123",
      });
      expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Approval resolved");
      expect(interaction["followUp"]).not.toHaveBeenCalled();
    },
  );

  it("shows the canonical result when the clicked message cannot be edited", async () => {
    const interaction = createInteraction({
      editReply: vi.fn(async () => {
        throw new Error("message edit failed");
      }),
    });
    const button = createButton();

    await button.run(interaction, click);

    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content: "Approval resolved: Allowed once.",
      ephemeral: true,
    });
  });

  it("cleans stale controls and shows the canonical winner after losing the race", async () => {
    const editReply = vi.fn();
    const interaction = createInteraction({ editReply }, "plugin", "plain-plugin-id");
    const resolution = createApprovalResolution({
      id: "plain-plugin-id",
      applied: false,
      status: "denied",
      decision: "deny",
    });
    resolveApprovalOverGatewayMock.mockResolvedValueOnce(resolution);
    const button = createExecApprovalButton(createContext());

    await button.run(interaction, {
      kind: "plugin",
      id: "plain-plugin-id",
      action: "allow-once",
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plain-plugin-id",
        approvalKind: "plugin",
        decision: "allow-once",
      }),
    );
    expect(interaction["editReply"]).toHaveBeenCalledTimes(1);
    const terminalPayload = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(terminalPayload).toContain("Approval already resolved");
    expect(terminalPayload).toContain("Recorded result: **Denied**");
    expect(terminalPayload).not.toContain("execapproval");
    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content: "This approval was already resolved: Denied.",
      ephemeral: true,
    });
  });

  it.each(["removed", "unreadable", "replacement"] as const)(
    "preserves the card with %s controls",
    async (state) => {
      const interaction = createInteraction(
        state === "removed"
          ? { fetchReply: vi.fn(async () => ({ components: [{ type: 10, content: "Applied" }] })) }
          : {},
        "system-agent",
        "replacement",
      );
      if (state === "unreadable") {
        vi.mocked(interaction.fetchReply).mockRejectedValue(new Error("message lookup failed"));
      }
      await createButton().run(interaction, { ...click, kind: "system-agent" });
      expect(interaction.fetchReply).toHaveBeenCalledOnce();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledExactlyOnceWith({
        content: "Approval resolved: Allowed once.",
        ephemeral: true,
      });
    },
  );

  it.each([
    [
      "error",
      "plugin",
      "deny",
      "Failed to submit approval decision for **Denied**. The request may have expired or already been resolved.",
    ],
    [
      "not-found",
      "exec",
      "allow-once",
      "That approval request is no longer pending. It may have expired or already been resolved.",
    ],
  ] as const)("shows a follow-up for %s resolution", async (reason, kind, action, content) => {
    const interaction = createInteraction();
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: false, reason }),
    });
    await button.run(interaction, { ...click, kind, action });
    expect(interaction.acknowledge).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({ content, ephemeral: true });
  });

  it.each([true, false])("classifies gateway errors with structured=%s", async (structured) => {
    const error = new Error("unknown or expired approval id");
    if (structured) {
      Object.assign(error, {
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_NOT_FOUND" },
      });
    }
    resolveApprovalOverGatewayMock.mockRejectedValue(error);
    await expect(
      createContext().resolveApproval("abc", structured ? "plugin" : "exec", "allow-once", "123"),
    ).resolves.toEqual({ ok: false, reason: structured ? "not-found" : "error" });
  });
});
