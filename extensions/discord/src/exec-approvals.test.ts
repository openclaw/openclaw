import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: DiscordExecApprovalConfig,
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>>,
): OpenClawConfig {
  return { channels: { discord: { token: "discord-token", ...channelOverrides, execApprovals } } };
}

function enabled(execApprovals?: DiscordExecApprovalConfig) {
  return isDiscordExecApprovalClientEnabled({ cfg: buildConfig(execApprovals) });
}

describe("discord exec approvals", () => {
  it("requires explicit enablement even when owner approvers resolve", () => {
    expect(enabled()).toBe(false);
    expect(enabled({ enabled: true })).toBe(false);
    expect(enabled({ approvers: ["123"] })).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: {
          ...buildConfig(),
          commands: { ownerAllowFrom: ["discord:789"] },
        },
      }),
    ).toBe(false);
    expect(enabled({ enabled: "auto", approvers: ["123"] })).toBe(true);
    expect(enabled({ enabled: false, approvers: ["123"] })).toBe(false);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig({ approvers: ["456"] }, { allowFrom: ["123"], defaultTo: "user:789" });

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["456"]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "123" })).toBe(false);
  });

  it("does not infer approvers from allowFrom or default DM routes", () => {
    const cfg = buildConfig(
      { enabled: true },
      { allowFrom: ["123", "456"], defaultTo: "user:789" },
    );

    expect(getDiscordExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("falls back to commands.ownerAllowFrom for exec approvers", () => {
    const cfg = {
      ...buildConfig(),
      commands: {
        ownerAllowFrom: [
          "discord:123",
          "user:456",
          "789",
          "discord:<@987>",
          "user:<@654>",
          "pk:999",
        ],
      },
    } as OpenClawConfig;

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["123", "456", "789", "987", "654"]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
  });

  it("accepts typed global owners without changing explicit approval targets", () => {
    const cfg = {
      ...buildConfig({ enabled: "auto" }),
      commands: { ownerAllowFrom: ["discord:user:123"] },
    } as OpenClawConfig;

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["123"]);
    expect(isDiscordExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(
      getDiscordExecApprovalApprovers({
        cfg,
        configOverride: { approvers: ["discord:user:456"] },
      }),
    ).toEqual(["456"]);
  });
});
