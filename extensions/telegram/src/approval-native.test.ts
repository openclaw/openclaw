import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

const cfg: OpenClawConfig = {
  channels: {
    telegram: {
      botToken: "tok",
      execApprovals: { enabled: true, approvers: ["8460800771"], target: "dm" },
    },
  },
};
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-approval-native-");
const requestTimes = { createdAtMs: 0, expiresAtMs: 1000 };

describe("telegram native approval adapter", () => {
  it.each([undefined, "work"])(
    "reserves terminal UI recovery for plugin approvals on account %s",
    (accountId) => {
      const params = { channel: "telegram", channelLabel: "Telegram", accountId };
      const execText = telegramApprovalCapability.describeExecApprovalSetup?.(params);
      const pluginText = telegramApprovalCapability.describePluginApprovalSetup?.(params);
      const prefix = accountId ? `channels.telegram.accounts.${accountId}` : "channels.telegram";

      expect(execText).toContain("Approve it from the Web UI for now.");
      expect(execText).not.toMatch(/terminal UI|\bTUI\b/i);
      expect(pluginText).toContain("Approve it from the Web UI or terminal UI for now.");
      expect(pluginText).toContain("Telegram supports native plugin approvals");
      expect(execText).toContain(`\`${prefix}.execApprovals.approvers\``);
      expect(pluginText).toContain(`\`${prefix}.execApprovals.approvers\``);
    },
  );

  it.each([
    ["direct:8460800771", "8460800771", "8460800771", undefined, "exec"],
    ["group:-1003841603622:topic:928", "-1003841603622:topic:928", "-1003841603622", 928, "exec"],
    [
      "group:-1003841603622:direct-topic:77",
      "-1003841603622:direct-topic:77",
      "-1003841603622:direct-topic:77",
      undefined,
      "system-agent",
    ],
  ] as const)(
    "resolves the turn-source target for %s",
    async (session, source, to, threadId, approvalKind) => {
      const target = await telegramApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind,
        request: {
          ...requestTimes,
          id: "req-1",
          request: {
            command: approvalKind === "exec" ? "echo hi" : "set config gateway.port 19001",
            turnSourceChannel: "telegram",
            turnSourceTo: `telegram:${source}`,
            turnSourceAccountId: "default",
            sessionKey: `agent:main:telegram:${session}`,
          },
        },
      });
      expect(target).toEqual({ to, threadId });
    },
  );

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003841603622:topic:928";
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "-1003841603622",
            accountId: "default",
            threadId: "928",
          },
        }),
      },
    });

    const target = await telegramApprovalCapability.native?.resolveOriginTarget?.({
      cfg: { ...cfg, session: { store: storePath } },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        ...requestTimes,
        id: "plugin:req-2",
        request: { title: "Plugin approval", description: "Allow access", sessionKey },
      },
    });

    expect(target).toEqual({ to: "-1003841603622", threadId: 928 });
  });
});
