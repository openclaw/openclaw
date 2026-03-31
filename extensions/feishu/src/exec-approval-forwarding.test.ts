import { describe, expect, it } from "vitest";
import {
  buildFeishuExecApprovalPendingPayload,
  shouldSuppressFeishuExecApprovalForwardingFallback,
} from "./exec-approval-forwarding.js";

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

function buildRequest(id = "approval-123") {
  return {
    id,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "rm -rf /tmp/test",
      cwd: "/home/user",
      host: "gateway" as const,
      agentId: "agent-1",
      sessionKey: "session-1",
    },
  } as never;
}

describe("buildFeishuExecApprovalPendingPayload target routing", () => {
  it("returns card for DM target when configured as dm", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result?.channelData?.feishu?.card).toBeDefined();
  });

  it("returns null for group target when configured as dm", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "chat:oc_group123" },
      nowMs: Date.now(),
    });
    expect(result).toBeNull();
  });

  it("returns card for group target when configured as channel", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "chat:oc_group123" },
      nowMs: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result?.channelData?.feishu?.card).toBeDefined();
  });

  it("returns null for DM target when configured as channel", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    expect(result).toBeNull();
  });

  it("returns card for both DM and group when configured as both", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "both" });
    const dmResult = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    const groupResult = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "chat:oc_group123" },
      nowMs: Date.now(),
    });
    expect(dmResult).not.toBeNull();
    expect(groupResult).not.toBeNull();
  });

  it("defaults to dm when no target configured", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"] });
    const dmResult = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    const groupResult = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "chat:oc_group123" },
      nowMs: Date.now(),
    });
    expect(dmResult).not.toBeNull();
    expect(groupResult).toBeNull();
  });

  it("detects bare ou_ IDs as DM targets", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "ou_abc123" },
      nowMs: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result?.channelData?.feishu?.card).toBeDefined();
  });

  it("detects bare on_ IDs as DM targets", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "on_abc123" },
      nowMs: Date.now(),
    });
    // on_ is a DM target, but config is channel-only → null
    expect(result).toBeNull();
  });

  it("returns null when exec approvals are disabled", () => {
    const cfg = buildConfig({ enabled: false, approvers: ["ou_123"], target: "both" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    expect(result).toBeNull();
  });

  it("returns null when no approvers are configured", () => {
    const cfg = buildConfig({ enabled: true, approvers: [], target: "both" });
    const result = buildFeishuExecApprovalPendingPayload({
      cfg,
      request: buildRequest(),
      target: { channel: "feishu", to: "user:ou_123" },
      nowMs: Date.now(),
    });
    expect(result).toBeNull();
  });
});

describe("shouldSuppressFeishuExecApprovalForwardingFallback", () => {
  it("returns false when client is not enabled", () => {
    const cfg = buildConfig({ enabled: false, approvers: ["ou_123"], target: "dm" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "chat:oc_group123" },
        request: buildRequest(),
      }),
    ).toBe(false);
  });

  it("suppresses group target when configured as dm", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "chat:oc_group123" },
        request: buildRequest(),
      }),
    ).toBe(true);
  });

  it("does not suppress DM target when configured as dm", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "user:ou_123" },
        request: buildRequest(),
      }),
    ).toBe(false);
  });

  it("suppresses DM target when configured as channel", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "user:ou_123" },
        request: buildRequest(),
      }),
    ).toBe(true);
  });

  it("does not suppress group target when configured as channel", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "chat:oc_group123" },
        request: buildRequest(),
      }),
    ).toBe(false);
  });

  it("does not suppress any target when configured as both", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "both" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "user:ou_123" },
        request: buildRequest(),
      }),
    ).toBe(false);
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "chat:oc_group123" },
        request: buildRequest(),
      }),
    ).toBe(false);
  });

  it("suppresses bare ou_ DM target when configured as channel", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "channel" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "ou_abc123" },
        request: buildRequest(),
      }),
    ).toBe(true);
  });

  it("does not suppress bare ou_ DM target when configured as dm", () => {
    const cfg = buildConfig({ enabled: true, approvers: ["ou_123"], target: "dm" });
    expect(
      shouldSuppressFeishuExecApprovalForwardingFallback({
        cfg,
        target: { channel: "feishu", to: "ou_abc123" },
        request: buildRequest(),
      }),
    ).toBe(false);
  });
});
