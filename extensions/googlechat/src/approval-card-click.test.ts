import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleChatApprovalActionParameters,
  clearGoogleChatApprovalCardBindingsForTest,
  registerGoogleChatApprovalCardBinding,
} from "./approval-card-actions.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
const isApprovalNotFoundError = vi.hoisted(() => vi.fn(() => false));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  isApprovalNotFoundError,
}));

function createTarget(): WebhookTarget {
  return {
    account: {
      accountId: "default",
      enabled: true,
      credentialSource: "inline",
      config: {
        dm: { allowFrom: ["users/123"] },
      },
    },
    config: {
      channels: {
        googlechat: {
          dm: { allowFrom: ["users/123"] },
        },
      },
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    core: {} as never,
    path: "/googlechat",
    mediaMaxMb: 20,
  };
}

function createCardClickEvent(token: string, userName = "users/123"): GoogleChatEvent {
  return {
    type: "CARD_CLICKED",
    space: { name: "spaces/AAA" },
    message: { name: "spaces/AAA/messages/msg-1" },
    user: { name: userName },
    action: {
      actionMethodName: "openclaw.approval",
      parameters: buildGoogleChatApprovalActionParameters(token),
    },
  };
}

describe("maybeHandleGoogleChatApprovalCardClick", () => {
  beforeEach(() => {
    clearGoogleChatApprovalCardBindingsForTest();
    resolveApprovalOverGateway.mockReset();
    isApprovalNotFoundError.mockReset();
    isApprovalNotFoundError.mockReturnValue(false);
  });

  it("authorizes the Chat actor and resolves the bound approval over the gateway", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-1",
      accountId: "default",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-1"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      approvalId: "approval-1",
      decision: "allow-once",
      senderId: "users/123",
      allowPluginFallback: true,
      clientDisplayName: "Google Chat approval (users/123)",
    });
  });

  it("accepts add-on clicks that only carry approval token parameters", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-addon",
      accountId: "default",
      approvalId: "approval-addon",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          commonEventObject: {
            parameters: {
              openclaw_action: "approval",
              token: "token-addon",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-addon",
        decision: "allow-once",
      }),
    );
  });

  it("accepts standard cardsV2 clicks with common parameters", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-common",
      accountId: "default",
      approvalId: "approval-common",
      approvalKind: "plugin",
      decision: "deny",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          common: {
            invokedFunction: "openclaw.approval",
            parameters: {
              openclaw_action: "approval",
              token: "token-common",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-common",
        decision: "deny",
        allowPluginFallback: false,
      }),
    );
  });

  it("accepts endpoint URL invoked functions for app-url card actions", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-url",
      accountId: "default",
      approvalId: "approval-url",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          commonEventObject: {
            invokedFunction: "https://chat-app.example.test/googlechat",
            parameters: {
              openclaw_action: "approval",
              token: "token-url",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-url",
        decision: "allow-once",
      }),
    );
  });

  it("does not consume the token when an unauthorized user clicks", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-2",
      accountId: "default",
      approvalId: "plugin:approval-2",
      approvalKind: "plugin",
      decision: "deny",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-2", "users/999"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-2", "users/123"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plugin:approval-2",
        decision: "deny",
        allowPluginFallback: false,
      }),
    );
  });

  it("keeps the token retryable when gateway resolution fails", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-retry",
      accountId: "default",
      approvalId: "approval-retry",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-retry"),
        target: createTarget(),
      }),
    ).rejects.toThrow("gateway unavailable");

    resolveApprovalOverGateway.mockResolvedValueOnce(undefined);
    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-retry"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  });

  it("consumes stale approval card tokens when gateway reports approval not found", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-stale",
      accountId: "default",
      approvalId: "approval-stale",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    resolveApprovalOverGateway.mockRejectedValueOnce(
      Object.assign(new Error("approval not found"), { gatewayCode: "APPROVAL_NOT_FOUND" }),
    );
    isApprovalNotFoundError.mockReturnValueOnce(true);
    const target = createTarget();

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-stale"),
        target,
      }),
    ).resolves.toBe(true);

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-stale"),
        target,
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(target.runtime.log).toHaveBeenCalledWith(
      "[default] googlechat approval ignored: expired approval id=approval-stale",
    );
    expect(target.runtime.log).toHaveBeenCalledWith(
      "[default] googlechat approval ignored: unknown or expired card token",
    );
  });
});
