import { describe, expect, it } from "vitest";
import {
  resolveFeishuExecApprovalConfig,
  getFeishuExecApprovalApprovers,
  isFeishuExecApprovalClientEnabled,
  isFeishuExecApprovalApprover,
  resolveFeishuExecApprovalTarget,
  shouldSuppressLocalFeishuExecApprovalPrompt,
} from "./exec-approvals.js";

function buildConfig(execApprovals?: Record<string, unknown>) {
  return {
    channels: {
      feishu: {
        appId: "cli_test",
        appSecret: "secret",
        ...(execApprovals ? { execApprovals } : {}),
      },
    },
  } as never;
}

describe("resolveFeishuExecApprovalConfig", () => {
  it("returns undefined when no execApprovals config", () => {
    expect(resolveFeishuExecApprovalConfig({ cfg: buildConfig() })).toBeUndefined();
  });

  it("returns config when execApprovals is present", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"] });
    const result = resolveFeishuExecApprovalConfig({ cfg });
    expect(result).toEqual({ enabled: true, approvers: ["ou_123"] });
  });
});

describe("getFeishuExecApprovalApprovers", () => {
  it("returns empty array when no config", () => {
    expect(getFeishuExecApprovalApprovers({ cfg: buildConfig() })).toEqual([]);
  });

  it("normalizes approver IDs to strings", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123", 456] });
    expect(getFeishuExecApprovalApprovers({ cfg })).toEqual(["ou_123", "456"]);
  });

  it("filters empty approver IDs", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123", "", "  "] });
    expect(getFeishuExecApprovalApprovers({ cfg })).toEqual(["ou_123"]);
  });
});

describe("isFeishuExecApprovalClientEnabled", () => {
  it("returns false when no config", () => {
    expect(isFeishuExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
  });

  it("returns false when enabled but no approvers", () => {
    const cfg = buildConfig({ enabled: true, approvers: [] });
    expect(isFeishuExecApprovalClientEnabled({ cfg })).toBe(false);
  });

  it("returns false when not enabled", () => {
    const cfg = buildConfig({ enabled: false, approvers: ["ou_123"] });
    expect(isFeishuExecApprovalClientEnabled({ cfg })).toBe(false);
  });

  it("returns true when enabled with approvers", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"] });
    expect(isFeishuExecApprovalClientEnabled({ cfg })).toBe(true);
  });
});

describe("isFeishuExecApprovalApprover", () => {
  const cfg = buildConfig({ enabled: true, approvers: ["ou_123", "ou_456"] });

  it("returns false for null senderId", () => {
    expect(isFeishuExecApprovalApprover({ cfg, senderId: null })).toBe(false);
  });

  it("returns false for empty senderId", () => {
    expect(isFeishuExecApprovalApprover({ cfg, senderId: "" })).toBe(false);
  });

  it("returns true for valid approver", () => {
    expect(isFeishuExecApprovalApprover({ cfg, senderId: "ou_123" })).toBe(true);
  });

  it("returns false for non-approver", () => {
    expect(isFeishuExecApprovalApprover({ cfg, senderId: "ou_999" })).toBe(false);
  });
});

describe("resolveFeishuExecApprovalTarget", () => {
  it("defaults to dm", () => {
    expect(resolveFeishuExecApprovalTarget({ cfg: buildConfig() })).toBe("dm");
  });

  it("returns configured target", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "both" });
    expect(resolveFeishuExecApprovalTarget({ cfg })).toBe("both");
  });
});

describe("shouldSuppressLocalFeishuExecApprovalPrompt", () => {
  const execApprovalPayload = {
    channelData: { execApproval: { approvalId: "test1234", approvalSlug: "test1234" } },
  } as never;
  const plainPayload = { text: "hello" } as never;

  it("returns false when client is not enabled", () => {
    const cfg = buildConfig({ enabled: false, approvers: ["ou_123"] });
    expect(shouldSuppressLocalFeishuExecApprovalPrompt({ cfg, payload: execApprovalPayload })).toBe(
      false,
    );
  });

  it("returns false when no exec approval data in payload", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"] });
    expect(shouldSuppressLocalFeishuExecApprovalPrompt({ cfg, payload: plainPayload })).toBe(false);
  });

  it("returns true when client enabled and payload has exec approval data", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"] });
    expect(shouldSuppressLocalFeishuExecApprovalPrompt({ cfg, payload: execApprovalPayload })).toBe(
      true,
    );
  });
});
