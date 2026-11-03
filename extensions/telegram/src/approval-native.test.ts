import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

// The capability is built while the module loads; record SDK warnings from that import.
const emitWarning = vi.hoisted(() => vi.spyOn(process, "emitWarning"));
const loadDeprecations = emitWarning.mock.calls
  .filter(([, options]) => typeof options === "object" && options.code === "DEP_PLUGIN_SDK")
  .map(([message]) => String(message));
emitWarning.mockRestore();

const execApprovals = { enabled: true, approvers: ["8460800771"], target: "dm" as const };
const cfg: OpenClawConfig = { channels: { telegram: { botToken: "tok", execApprovals } } };
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-approval-native-");
const requestTimes = { createdAtMs: 0, expiresAtMs: 1000 };
const chatId = "-1003841603622";
const directTopic = `${chatId}:direct-topic:77`;

describe("telegram native approval adapter", () => {
  it("builds the approval capability without deprecated Plugin SDK factories", async () => {
    expect(loadDeprecations).toEqual([]);
    const authorize = async (senderId: string) =>
      (
        await telegramApprovalCapability.authorizeActorActionAsync?.({
          cfg,
          accountId: "default",
          senderId,
          action: "approve",
          approvalKind: "exec",
        })
      )?.authorized;
    expect(await authorize("8460800771")).toBe(true);
    expect(await authorize("1234")).toBe(false);
    expect(
      await telegramApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: { ...requestTimes, id: "req-0", request: { command: "echo hi" } },
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

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
    [`group:${chatId}:topic:928`, `${chatId}:topic:928`, chatId, 928, "exec"],
    [`group:${directTopic}`, directTopic, directTopic, undefined, "system-agent"],
  ] as const)(
    "resolves the turn-source target for %s",
    async (session, source, to, threadId, approvalKind) => {
      const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
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
    const sessionKey = `agent:main:telegram:group:${chatId}:topic:928`;
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: chatId,
            accountId: "default",
            threadId: "928",
          },
        }),
      },
    });

    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: { ...cfg, session: { store: storePath } },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        ...requestTimes,
        id: "plugin:req-2",
        request: { title: "Plugin approval", description: "Allow access", sessionKey },
      },
    });

    expect(target).toEqual({ to: chatId, threadId: 928 });
  });
});
