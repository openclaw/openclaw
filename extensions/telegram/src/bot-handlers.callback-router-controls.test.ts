import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { TelegramApprovalCallback } from "./approval-callback-data.js";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import type { TelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import { createTelegramCallbackApprovalRuntime } from "./bot-handlers.callback-router-controls.js";

const refusal = () =>
  Object.assign(new Error("approval decision requires a listed approver"), {
    gatewayCode: "FORBIDDEN",
    details: { code: "APPROVAL_AUTHORITY_REQUIRED" },
  });
const notFound = () =>
  Object.assign(new Error("unknown or expired approval id"), {
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "APPROVAL_NOT_FOUND" },
  });

const runtimeCfg: OpenClawConfig = {
  channels: {
    telegram: {
      dmPolicy: "open",
      allowFrom: ["*"],
      execApprovals: { enabled: true, approvers: ["9"], target: "dm" },
    },
  },
};

function createRuntime(failures: Array<() => Error>) {
  const resolveApproval = vi.fn<NonNullable<TelegramBotDeps["resolveApproval"]>>();
  for (const failure of failures) {
    resolveApproval.mockRejectedValueOnce(failure());
  }
  const actions = {
    editCallbackMessage: vi.fn<TelegramCallbackMessageActions["editCallbackMessage"]>(),
    clearCallbackButtons: vi.fn<TelegramCallbackMessageActions["clearCallbackButtons"]>(),
    editCallbackButtons: vi.fn<TelegramCallbackMessageActions["editCallbackButtons"]>(),
    editCallbackMessageWithButtons:
      vi.fn<TelegramCallbackMessageActions["editCallbackMessageWithButtons"]>(),
    deleteCallbackMessage: vi.fn<TelegramCallbackMessageActions["deleteCallbackMessage"]>(),
    replyToCallbackChat: vi.fn<TelegramCallbackMessageActions["replyToCallbackChat"]>(),
  } satisfies TelegramCallbackMessageActions;
  const runtime = createTelegramCallbackApprovalRuntime({
    accountId: "default",
    telegramDeps: { ...defaultTelegramBotDeps, resolveApproval },
    runtimeCfg,
    senderId: "9",
    actions,
  });
  return { runtime, actions, resolveApproval };
}

// A refusal answers who may decide, not whether the approval is still open: the buttons stay
// for a listed approver, and it is not retried. A missing approval gets the terminal receipt.
describe("telegram approval callbacks refused by the Gateway", () => {
  const canonical: TelegramApprovalCallback = {
    type: "approval",
    approvalId: "refused-approval",
    approvalKind: "exec",
    decision: "allow-once",
  };

  it("keeps the buttons of a typed callback without a retry", async () => {
    const { runtime, actions, resolveApproval } = createRuntime([refusal]);
    await expect(runtime.handleCanonical(canonical)).resolves.toBeUndefined();
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(actions.editCallbackMessage).not.toHaveBeenCalled();
    expect(actions.clearCallbackButtons).not.toHaveBeenCalled();
    expect(actions.replyToCallbackChat).not.toHaveBeenCalled();
  });

  it("retires a typed callback whose approval is gone", async () => {
    const { runtime, actions } = createRuntime([notFound]);
    await runtime.handleCanonical(canonical);
    expect(actions.editCallbackMessage).toHaveBeenCalledWith(
      expect.stringContaining("Approval no longer pending"),
      { reply_markup: { inline_keyboard: [] } },
    );
  });

  it.each([
    ["keeps the buttons when exec refuses and plugin is missing", [refusal, notFound], 0],
    ["keeps the buttons when exec is missing and plugin refuses", [notFound, refusal], 0],
    ["retires the card when every kind is missing", [notFound, notFound], 1],
  ])("legacy callback %s", async (_label, failures, edits) => {
    const legacy = parseExecApprovalCommandText("/approve 138e9b8c allow-once");
    if (!legacy) {
      throw new Error("Expected a legacy approval command");
    }
    const { runtime, actions, resolveApproval } = createRuntime(failures);
    await expect(runtime.handleLegacy(legacy)).resolves.toBeUndefined();
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    expect(actions.editCallbackMessage).toHaveBeenCalledTimes(edits);
  });
});
