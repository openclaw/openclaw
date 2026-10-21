import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { getDiscordApprovalCapability } from "./approval-native.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-discord-approval-native-test.json");
const NATIVE_APPROVAL_CFG = {
  commands: { ownerAllowFrom: ["discord:555555555"] },
} satisfies OpenClawConfig;
const NATIVE_DELIVERY_CFG = {
  ...NATIVE_APPROVAL_CFG,
  channels: { discord: { execApprovals: { enabled: true } } },
} satisfies OpenClawConfig;
const ORIGIN = {
  turnSourceChannel: "discord",
  turnSourceTo: "123456789",
  turnSourceAccountId: "main",
};
const execRequest = (request: ExecApprovalRequest["request"]): ExecApprovalRequest => ({
  id: "approval-1",
  request,
  createdAtMs: 1,
  expiresAtMs: 2,
});

function createDiscordNativeApprovalAdapter() {
  return splitChannelApprovalCapability(getDiscordApprovalCapability());
}

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

function resolveOriginTarget(
  request: Partial<PluginApprovalRequest["request"]>,
  options: { cfg?: OpenClawConfig; accountId?: string } = {},
) {
  return createDiscordNativeApprovalAdapter().nativeAsync?.resolveOriginTarget?.({
    cfg: options.cfg ?? NATIVE_DELIVERY_CFG,
    accountId: options.accountId ?? "main",
    approvalKind: "plugin",
    request: {
      id: "abc",
      request: {
        title: "Plugin approval",
        description: "Let plugin proceed",
        ...request,
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    },
  });
}

describe("createDiscordNativeApprovalAdapter", () => {
  it("subscribes the native runtime to system-agent approval events", () => {
    expect(getDiscordApprovalCapability().nativeRuntimeAsync?.eventKinds).toContain("system-agent");
  });

  it("keeps approval availability enabled when approvers exist but native delivery is off", async () => {
    const adapter = createDiscordNativeApprovalAdapter();
    const cfg = {
      ...NATIVE_APPROVAL_CFG,
      channels: {
        discord: {
          execApprovals: {
            enabled: false,
            approvers: ["555555555"],
            target: "channel",
          },
        },
      },
    } as const;

    expect(
      adapter.auth?.getActionAvailabilityState?.({
        cfg: cfg as never,
        accountId: "main",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      await adapter.nativeAsync?.describeDeliveryCapabilities({
        cfg: cfg as never,
        accountId: "main",
        approvalKind: "exec",
        request: execRequest({
          command: "pwd",
          ...ORIGIN,
          turnSourceTo: "channel:123456789",
          sessionKey: "agent:main:discord:channel:123456789",
        }),
      }),
    ).toEqual({
      enabled: false,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("lets only the current typed Discord owner approve owner-derived exec requests", async () => {
    const capability = getDiscordApprovalCapability();
    const cfg = {
      commands: { ownerAllowFrom: ["discord:user:555555555"] },
      channels: {
        discord: {
          execApprovals: { enabled: "auto" },
          accounts: { main: {}, ops: { execApprovals: { approvers: ["777777777"] } } },
        },
      },
    } as OpenClawConfig;
    const authorize = async (
      senderId: string,
      options: { cfg?: OpenClawConfig; accountId?: string } = {},
    ) =>
      (
        await capability.authorizeActorActionAsync?.({
          cfg: options.cfg ?? cfg,
          accountId: options.accountId ?? "main",
          senderId,
          action: "approve",
          approvalKind: "exec",
        })
      )?.authorized;
    const request = execRequest({
      command: "pwd",
      turnSourceChannel: "discord",
      turnSourceAccountId: "main",
    });

    expect(
      await createDiscordNativeApprovalAdapter().nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "main",
        approvalKind: "exec",
        request,
      }),
    ).toEqual([{ to: "555555555" }]);
    expect(await authorize("555555555")).toBe(true);
    expect(await authorize("666666666")).toBe(false);
    // Explicit account approvers still replace the global owner fallback.
    expect(await authorize("555555555", { accountId: "ops" })).toBe(false);
    // Authority is read from the config current at decision time.
    expect(
      await authorize("555555555", {
        cfg: { ...cfg, commands: { ownerAllowFrom: ["discord:user:888888888"] } },
      }),
    ).toBe(false);
  });

  it.each([undefined, "work"])("describes the %s exec-approval setup path", (accountId) => {
    const text = getDiscordApprovalCapability().describeExecApprovalSetup?.({
      channel: "discord",
      channelLabel: "Discord",
      accountId,
    });
    const prefix = accountId ? `channels.discord.accounts.${accountId}` : "channels.discord";
    expect(text).toContain(`\`${prefix}.execApprovals.approvers\``);
    expect(text).toContain("Approve it from the Web UI for now.");
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.discord.dm.allowFrom`");
    if (accountId) {
      expect(text).not.toContain("`channels.discord.execApprovals.approvers`");
    }
  });

  it.each([
    [
      "prefixed turn source",
      { ...ORIGIN, turnSourceTo: "channel:123456789" },
      { to: "123456789" },
      "main",
    ],
    [
      "account-scoped DM",
      { ...ORIGIN, sessionKey: "agent:main:discord:default:direct:123456789" },
      null,
      "main",
    ],
    [
      "raw channel source",
      { ...ORIGIN, sessionKey: "agent:main:discord:channel:123456789" },
      { to: "123456789", threadId: undefined },
      "main",
    ],
    [
      "thread session fallback",
      { sessionKey: "agent:main:discord:channel:987654321:thread:444555666" },
      { to: "987654321", threadId: "444555666" },
      "default",
    ],
  ] as const)("resolves %s", async (_name, request, expected, accountId) => {
    expect(await resolveOriginTarget(request, { accountId })).toEqual(expected);
  });

  it("ignores session-store turn targets for Discord DM sessions", async () => {
    writeStore({
      "agent:main:discord:dm:123456789": {
        sessionId: "sess",
        updatedAt: Date.now(),
        origin: { provider: "discord", to: "123456789", accountId: "main" },
        lastChannel: "discord",
        lastTo: "123456789",
        lastAccountId: "main",
      },
    });

    const target = await resolveOriginTarget(
      {
        sessionKey: "agent:main:discord:dm:123456789",
        ...ORIGIN,
      },
      {
        cfg: {
          ...NATIVE_DELIVERY_CFG,
          session: { store: STORE_PATH },
        },
      },
    );

    expect(target).toBeNull();
  });

  it("rejects origin delivery for requests bound to another Discord account", async () => {
    const target = await resolveOriginTarget(
      {
        ...ORIGIN,
        turnSourceTo: "channel:123456789",
        turnSourceAccountId: "other",
        sessionKey: "agent:main:missing",
      },
      { cfg: NATIVE_APPROVAL_CFG },
    );

    expect(target).toBeNull();
  });
});
