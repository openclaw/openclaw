import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  getMatrixExecApprovalApprovers,
  isMatrixExecApprovalApprover,
  isMatrixExecApprovalAuthorizedSender,
  isMatrixExecApprovalClientEnabled,
  isMatrixExecApprovalTargetRecipient,
  normalizeMatrixApproverId,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixExecApprovalRequest,
  shouldSuppressLocalMatrixExecApprovalPrompt,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("matrix exec approvals", () => {
  it("requires enablement and an explicit or inferred approver", () => {
    expect(isMatrixExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(isMatrixExecApprovalClientEnabled({ cfg: buildConfig({ enabled: true }) })).toBe(false);
    expect(
      isMatrixExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }, { dm: { allowFrom: ["@owner:example.org"] } }),
      }),
    ).toBe(true);
    expect(
      isMatrixExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe(true);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { enabled: true, approvers: ["user:@override:example.org"] },
      { dm: { allowFrom: ["@owner:example.org"] } },
    );

    expect(getMatrixExecApprovalApprovers({ cfg })).toEqual(["@override:example.org"]);
    expect(isMatrixExecApprovalApprover({ cfg, senderId: "@override:example.org" })).toBe(true);
    expect(isMatrixExecApprovalApprover({ cfg, senderId: "@owner:example.org" })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveMatrixExecApprovalTarget({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe("dm");
  });

  it("matches matrix target recipients from generic approval forwarding targets", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "matrix", to: "user:@target:example.org" },
            { channel: "matrix", to: "room:!ops:example.org" },
          ],
        },
      },
    } as OpenClawConfig;

    expect(isMatrixExecApprovalTargetRecipient({ cfg, senderId: "@target:example.org" })).toBe(
      true,
    );
    expect(isMatrixExecApprovalTargetRecipient({ cfg, senderId: "@other:example.org" })).toBe(
      false,
    );
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@target:example.org" })).toBe(
      true,
    );
  });

  it("suppresses local prompts only when the native client is enabled", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
        },
      },
    };

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
        payload,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
      }),
    ).toBe(false);
  });

  it("normalizes prefixed approver ids", () => {
    expect(normalizeMatrixApproverId("matrix:@owner:example.org")).toBe("@owner:example.org");
    expect(normalizeMatrixApproverId("user:@owner:example.org")).toBe("@owner:example.org");
  });

  it("applies agent and session filters to request handling", () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["@owner:example.org"],
      agentFilter: ["ops-agent"],
      sessionFilter: ["matrix:channel:", "ops$"],
    });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            agentId: "ops-agent",
            sessionKey: "agent:ops-agent:matrix:channel:!room:example.org:ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        request: {
          id: "req-2",
          request: {
            command: "echo hi",
            agentId: "other-agent",
            sessionKey: "agent:other-agent:matrix:channel:!room:example.org:ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);
  });
});
