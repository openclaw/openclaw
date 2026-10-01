// Telegram tests cover exec approvals plugin behavior.
import path from "node:path";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  shouldHandleTelegramExecApprovalRequest,
  shouldInjectTelegramExecApprovalButtons,
} from "./exec-approvals.js";

const tempWorkspaces: TempWorkspaceSync[] = [];

type TelegramExecApprovalRequest = Parameters<
  typeof shouldHandleTelegramExecApprovalRequest
>[0]["request"];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const workspace of tempWorkspaces.splice(0)) {
    workspace.cleanup();
  }
});

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

function buildMultiAccountTelegramConfig(params: {
  sessionStorePath?: string;
  opsOverrides?: Partial<TelegramAccountConfig>;
}): OpenClawConfig {
  return {
    ...(params.sessionStorePath ? { session: { store: params.sessionStorePath } } : {}),
    channels: {
      telegram: {
        accounts: {
          default: {
            botToken: "tok-default",
            execApprovals: { enabled: true, approvers: ["123"] },
          },
          ops: {
            botToken: "tok-ops",
            ...params.opsOverrides,
            execApprovals: { enabled: true, approvers: ["123"] },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function makeChannelApprovalRequest(params: {
  id: string;
  sessionKey?: string;
  turnSourceChannel?: string;
}): TelegramExecApprovalRequest {
  return {
    id: params.id,
    request: {
      command: "echo hi",
      sessionKey: params.sessionKey ?? "agent:ops:missing",
      turnSourceChannel: params.turnSourceChannel ?? "slack",
      turnSourceTo: "channel:C123",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("telegram exec approvals", () => {
  it("matches approvers by normalized sender id", () => {
    const cfg = buildConfig({ approvers: [123, "456"] });
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "123" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("infers approvers from command owners", () => {
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
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        request: makeChannelApprovalRequest({
          id: "command-owner-inference",
          turnSourceChannel: "telegram",
        }),
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

  it("scopes non-telegram turn sources to the stored telegram account", async () => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-telegram-exec-approvals-",
    });
    tempWorkspaces.push(workspace);
    const tmpDir = workspace.dir;
    const storePath = path.join(tmpDir, "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:ops:telegram:direct:123",
      entry: {
        sessionId: "main",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", accountId: "ops" },
          origin: { provider: "telegram", accountId: "ops" },
        }),
      },
    });
    const cfg = buildMultiAccountTelegramConfig({ sessionStorePath: storePath });
    const request = makeChannelApprovalRequest({
      id: "req-2",
      sessionKey: "agent:ops:telegram:direct:123",
    });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(true);
  });

  it("ignores disabled telegram accounts when checking unbound account eligibility", () => {
    const cfg = buildMultiAccountTelegramConfig({ opsOverrides: { enabled: false } });
    const request = makeChannelApprovalRequest({
      id: "req-6",
      turnSourceChannel: "telegram",
    });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
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

  it.each([
    {
      name: "normalizes a prefixed DM and account identity",
      target: { channel: "telegram", to: "tg:12345", accountId: "Work Bot" },
      accountId: "work-bot",
      mode: "targets" as const,
      expected: true,
    },
    {
      name: "rejects a different sender at the same direct target",
      target: { channel: "telegram", to: "12345" },
      senderId: "99999",
      mode: "targets" as const,
      expected: false,
    },
    {
      name: "rejects a different callback account",
      target: { channel: "telegram", to: "12345", accountId: "work" },
      accountId: "personal",
      mode: "targets" as const,
      expected: false,
    },
    {
      name: "rejects foreign-channel targets",
      target: { channel: "discord", to: "12345" },
      mode: "targets" as const,
      expected: false,
    },
    {
      name: "rejects group targets even when the sender string matches",
      target: { channel: "telegram", to: "-100123456" },
      senderId: "-100123456",
      mode: "targets" as const,
      expected: false,
    },
    {
      name: "does not authorize an inactive forwarding target",
      target: { channel: "telegram", to: "12345" },
      mode: "session" as const,
      expected: false,
    },
    {
      name: "allows an unscoped target from a named callback account",
      target: { channel: "telegram", to: "12345" },
      accountId: "any-account",
      mode: "targets" as const,
      expected: true,
    },
    {
      name: "keeps target eligibility when the callback account is unspecified",
      target: { channel: "telegram", to: "12345", accountId: "work" },
      mode: "targets" as const,
      expected: true,
    },
  ])("$name", ({ target, accountId, senderId = "12345", mode, expected }) => {
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
