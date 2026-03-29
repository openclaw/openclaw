import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  resolveTelegramExecApprovalTarget,
  shouldEnableTelegramExecApprovalButtons,
  shouldInjectTelegramExecApprovalButtons,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>["execApprovals"],
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("telegram exec approvals", () => {
  it("requires enablement and at least one approver", () => {
    expect(isTelegramExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      }),
    ).toBe(true);
  });

  it("matches approvers by normalized sender id", () => {
    const cfg = buildConfig({ enabled: true, approvers: [123, "456"] });
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "123" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveTelegramExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["1"] }) }),
    ).toBe("dm");
  });

  it("only injects approval buttons on eligible telegram targets", () => {
    const dmCfg = buildConfig({ enabled: true, approvers: ["123"], target: "dm" });
    const channelCfg = buildConfig({ enabled: true, approvers: ["123"], target: "channel" });
    const bothCfg = buildConfig({ enabled: true, approvers: ["123"], target: "both" });

    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "-100123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "-100123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "-100123" })).toBe(true);
  });

  it("does not require generic inlineButtons capability to enable exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: ["vision"],
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(true);
  });

  it("still respects explicit inlineButtons off for exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: { inlineButtons: "off" },
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(false);
  });

  describe("isTelegramExecApprovalTargetRecipient", () => {
    function buildTargetConfig(
      targets: Array<{ channel: string; to: string; accountId?: string }>,
    ): OpenClawConfig {
      return {
        channels: { telegram: { botToken: "tok" } },
        approvals: { exec: { enabled: true, mode: "targets", targets } },
      } as OpenClawConfig;
    }

    it("accepts sender who is a DM target", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("rejects sender not in any target", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "99999" })).toBe(false);
    });

    it("rejects group targets", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "-100123456" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "123456" })).toBe(false);
    });

    it("ignores non-telegram targets", () => {
      const cfg = buildTargetConfig([{ channel: "discord", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("returns false when no targets configured", () => {
      const cfg = buildConfig();
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("returns false when senderId is empty or null", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "" })).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: null })).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg })).toBe(false);
    });

    it("matches across multiple targets", () => {
      const cfg = buildTargetConfig([
        { channel: "slack", to: "U12345" },
        { channel: "telegram", to: "67890" },
        { channel: "telegram", to: "11111" },
      ]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "67890" })).toBe(true);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "11111" })).toBe(true);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "U12345" })).toBe(false);
    });

    it("scopes by accountId in multi-bot deployments", () => {
      const cfg = buildTargetConfig([
        { channel: "telegram", to: "12345", accountId: "account-a" },
        { channel: "telegram", to: "67890", accountId: "account-b" },
      ]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "account-a" }),
      ).toBe(true);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "account-b" }),
      ).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("allows unscoped targets regardless of callback accountId", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "any-account" }),
      ).toBe(true);
    });

    it("requires active target forwarding mode", () => {
      const cfg = {
        channels: { telegram: { botToken: "tok" } },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
            targets: [{ channel: "telegram", to: "12345" }],
          },
        },
      } as OpenClawConfig;
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("normalizes prefixed Telegram DM targets", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "tg:12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("normalizes accountId matching", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345", accountId: "Work Bot" }]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "work-bot" }),
      ).toBe(true);
    });
  });

  describe("isTelegramExecApprovalAuthorizedSender", () => {
    it("accepts explicit approvers", () => {
      const cfg = buildConfig({ enabled: true, approvers: ["123"] });
      expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "123" })).toBe(true);
    });

    it("accepts active forwarded DM targets", () => {
      const cfg = {
        channels: { telegram: { botToken: "tok" } },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "telegram", to: "12345" }],
          },
        },
      } as OpenClawConfig;
      expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "12345" })).toBe(true);
    });
  });
});
