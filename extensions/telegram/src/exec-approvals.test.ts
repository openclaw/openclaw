import path from "node:path";
import type {
  OpenClawConfig,
  TelegramExecApprovalConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  shouldHandleTelegramExecApprovalRequest,
  shouldInjectTelegramExecApprovalButtons,
} from "./exec-approvals.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-exec-approvals-");

type TelegramExecApprovalRequest = Parameters<
  typeof shouldHandleTelegramExecApprovalRequest
>[0]["request"];

function buildConfig(
  execApprovals?: TelegramExecApprovalConfig,
  channelOverrides?: NonNullable<OpenClawConfig["channels"]>["telegram"],
): OpenClawConfig {
  return {
    channels: { telegram: { botToken: "tok", ...channelOverrides, execApprovals } },
  } as OpenClawConfig;
}

async function storeDelivery(storePath: string, accountId: string, updatedAt: number) {
  await upsertSessionEntry({
    storePath,
    sessionKey: "agent:ops:telegram:direct:123",
    entry: {
      sessionId: "main",
      updatedAt,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", accountId },
        origin: { provider: "telegram", accountId },
      }),
    },
  });
}

function buildMultiAccountTelegramConfig(store?: string, enabled = true): OpenClawConfig {
  const execApprovals = { enabled: true, approvers: ["123"] };
  return {
    channels: {
      telegram: {
        accounts: {
          default: { botToken: "tok-default", execApprovals },
          ops: { botToken: "tok-ops", execApprovals, enabled },
        },
      },
    },
    ...(store ? { session: { store } } : {}),
  };
}

function makeChannelApprovalRequest(
  id: string,
  turnSourceChannel = "telegram",
  sessionKey = "agent:ops:missing",
): TelegramExecApprovalRequest {
  return {
    id,
    request: { command: "echo hi", sessionKey, turnSourceChannel, turnSourceTo: "channel:C123" },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}
async function eligibleAccounts(cfg: OpenClawConfig, request: TelegramExecApprovalRequest) {
  const results = [];
  for (const accountId of ["default", "ops"]) {
    results.push(await shouldHandleTelegramExecApprovalRequest({ cfg, accountId, request }));
  }
  return results;
}

describe("telegram exec approvals", () => {
  it("matches approvers by normalized sender id", () => {
    const cfg = buildConfig({ approvers: [123, "456"] });
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "123" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("infers approvers from command owners", async () => {
    const cfg = {
      ...buildConfig(),
      commands: {
        ownerAllowFrom: ["telegram:12345", "tg:67890", "discord:ignored", "-100999"],
      },
    } as OpenClawConfig;

    expect(getTelegramExecApprovalApprovers({ cfg })).toEqual(["12345", "67890"]);
    expect(isTelegramExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "12345" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "67890" })).toBe(true);
    expect(
      await shouldHandleTelegramExecApprovalRequest({
        cfg,
        request: makeChannelApprovalRequest("command-owner-inference"),
      }),
    ).toBe(true);
  });

  it("does not infer approvers from Telegram chat allowlists", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["12345", "-100999", "@ignored"],
        defaultTo: 67890,
      },
    );

    expect(getTelegramExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(isTelegramExecApprovalClientEnabled({ cfg })).toBe(false);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "12345" })).toBe(false);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "67890" })).toBe(false);
  });

  it("routes non-telegram turn sources using the current stored telegram account", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    await storeDelivery(storePath, "ops", 1);
    const cfg = buildMultiAccountTelegramConfig(storePath);
    const request = makeChannelApprovalRequest("req-2", "slack", "agent:ops:telegram:direct:123");
    expect(await eligibleAccounts(cfg, request)).toEqual([false, true]);

    await storeDelivery(storePath, "default", 2);
    expect(await eligibleAccounts(cfg, request)).toEqual([true, false]);
  });

  it("ignores disabled telegram accounts when checking unbound account eligibility", async () => {
    const cfg = buildMultiAccountTelegramConfig(undefined, false);
    expect(await eligibleAccounts(cfg, makeChannelApprovalRequest("req-6"))).toEqual([true, false]);
  });

  it("only injects approval buttons on eligible telegram targets", () => {
    const results = (["dm", "channel", "both"] as const).map((target) => {
      const cfg = buildConfig({ enabled: true, approvers: ["123"], target });
      return ["123", "-100123"].map((to) => shouldInjectTelegramExecApprovalButtons({ cfg, to }));
    });
    expect(results).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
  });

  type Target = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>["targets"];
  const makeTarget = (to = "12345", accountId?: string, channel = "telegram") => ({
    channel,
    to,
    accountId,
  });
  it.each<
    [string, boolean, NonNullable<Target>[number], string?, string?, ("targets" | "session")?]
  >([
    ["prefixed DM/account", true, makeTarget("tg:12345", "Work Bot"), "work-bot"],
    ["different sender", false, makeTarget(), undefined, "99999"],
    ["different account", false, makeTarget("12345", "work"), "personal"],
    ["foreign channel", false, makeTarget("12345", undefined, "discord")],
    ["group target", false, makeTarget("-100123456"), undefined, "-100123456"],
    ["inactive forwarding", false, makeTarget(), undefined, undefined, "session"],
    ["unscoped target", true, makeTarget(), "any-account"],
    ["unspecified callback account", true, makeTarget("12345", "work")],
  ])("checks %s", (_name, expected, target, accountId, senderId = "12345", mode = "targets") => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok" } },
      approvals: { exec: { enabled: true, mode, targets: [target] } },
    };
    expect(isTelegramExecApprovalTargetRecipient({ cfg, accountId, senderId })).toBe(expected);
    expect(isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId })).toBe(expected);
  });

  it("authorizes explicit approvers even when the richer client is disabled", () => {
    const cfg = buildConfig({ enabled: false, approvers: ["123"] });
    expect(isTelegramExecApprovalClientEnabled({ cfg })).toBe(false);
    expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "123" })).toBe(true);
  });
});
